// @ts-nocheck
// Migration runner wrapping knex.migrate's built-in API.
// Replaces the vendored @umonaca/umzug wrapper (fork of umzug/umzug 2.x
// plus the knex-migrate CLI) with a direct dependency on knex's own
// migration engine, which is already the standard for Knex-based apps.

import { join } from 'path';
import knex from 'knex';
import * as knexfile from './knexfile.ts';
import Client_NodeSQLite from './node-sqlite-client.ts';
import migrations from './migrations/index.ts';

// knex's custom migrationSource contract. The manifest reports the ORIGINAL
// `.js` filenames, so knex_migrations rows written by the CommonJS version of
// this app stay valid and no migration runs a second time (see
// migrations/index.ts). A static list also bundles, unlike a directory scan.
const migrationSource = {
  getMigrations: () => migrations,
  getMigrationName: (migration) => migration.name,
  getMigration: (migration) => ({ up: migration.up, down: migration.down }),
};

function getMigrationsDir() {
  return join(import.meta.dirname, 'migrations');
}

function getKnexInstance() {
  const env = process.env.KNEX_ENV || process.env.NODE_ENV || 'upgrade';
  const config = Object.assign({}, knexfile[env]);
  if (config.client === Client_NodeSQLite) {
    config.useNullAsDefault = true;
  }
  config.pool = { max: 10, min: 0, idleTimeoutMillis: 1000 };
  return knex(config);
}

/**
 * Find a migration name by prefix (e.g. '20210213233544' matches
 * '20210213233544_fill_va_uuid.js'), matching the umzug fork's behaviour.
 */
function findMigrationFile(prefix) {
  const match = migrations.find((migration) => migration.name.startsWith(prefix));
  if (!match) {
    throw new Error(
      `Migration matching "${prefix}" not found in ${getMigrationsDir()}`
    );
  }
  return match.name;
}

/**
 * @param {string} command - 'up' or 'skipAll'
 * @param {object} [flags]
 * @param {object} [flags.to] - Only run up to / skip up to this migration
 *                               (prefix matched by startsWith)
 * @param {function} [progress] - Callback({action, migration}) per migration
 */
async function knexMigrate(command, flags, progress) {
  flags = flags || {};
  progress = progress || function () {};

  const migrationDir = getMigrationsDir();
  const db = getKnexInstance();

  // Config for knex.migrate: the migrations come from the manifest above, and
  // the table name is already picked up from the knexfile env's
  // migrations.tableName.
  // disableMigrationsListValidation: the knex_migrations table contains rows
  // for migration files that were deleted (e.g. the AI translation feature
  // removed in 7703841 deleted several migration files without cleaning up
  // their knex_migrations entries). Without this flag knex aborts with
  // 'migration directory is corrupt'. This mirrors the umzug fork's
  // skipTargetMigrationCheck behaviour.
  const migrateConfig = {
    migrationSource,
    disableMigrationsListValidation: true,
  };

  try {
    if (command === 'up') {
      if (flags.to) {
        // Run pending migrations one by one until we reach the target.
        const targetFile = findMigrationFile(flags.to);

        while (true) {
          const [, log] = await db.migrate.up(migrateConfig);
          if (log.length === 0) break; // No more pending
          progress({ action: 'migrate', migration: join(migrationDir, log[0]) });
          if (log[0] === targetFile) break;
        }
      } else {
        const [, log] = await db.migrate.latest(migrateConfig);
        for (const name of log) {
          progress({ action: 'migrate', migration: join(migrationDir, name) });
        }
      }
    } else if (command === 'skipAll') {
      // Mark migrations as executed without actually running them.
      const tableName =
        (db.client.config.migrations && db.client.config.migrations.tableName) ||
        'knex_migrations';

      const [completed, pending] = await db.migrate.list(migrateConfig);
      const completedNames = completed.map((m) => m.name);
      // `pending` holds the manifest entries, so the reported name is the
      // original `.js` filename the table records.
      const pendingFiles = pending.map((m) => migrationSource.getMigrationName(m));

      let toSkip = [];
      if (flags.to) {
        const targetFile = findMigrationFile(flags.to);
        const idx = pendingFiles.indexOf(targetFile);
        if (idx !== -1) {
          toSkip = pendingFiles.slice(0, idx + 1);
        }
        // If target is already completed, nothing to skip.
      } else {
        toSkip = pendingFiles;
      }

      if (toSkip.length > 0) {
        const batchNo = await db(tableName)
          .max('batch as max_batch')
          .then((r) => (r[0].max_batch || 0) + 1);
        const now = new Date();
        for (const name of toSkip) {
          await db(tableName).insert({
            name,
            batch: batchNo,
            migration_time: now,
          });
        }
      }
    }
  } finally {
    db.destroy();
  }
}

export default knexMigrate;
