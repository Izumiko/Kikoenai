// @ts-nocheck
/* eslint-disable n/no-unpublished-import */
// knex_migrations records migration NAMES, and the CommonJS version of this app
// wrote the original `.js` filenames. The manifest must keep reporting those
// names even though the files are `.ts` now: otherwise every migration re-runs
// against an existing database, and a database created here cannot be opened by
// upstream (or by an older install of this app).

import chai from 'chai';
const expect = chai.expect;
import fs from 'fs';
import os from 'os';
import path from 'path';
import knexLib from 'knex';

import migrations from '../database/migrations/index.ts';
import knexMigrate from '../database/knex-migrate.ts';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';
import * as knexfile from '../database/knexfile.ts';
import { dbVersion } from '../database/schema.ts';
import { createOldSchema } from './spinup/spinup-0.3.0.ts';

// The migration files this repository shipped before the TypeScript conversion,
// in filename order. A new upstream migration is appended here too.
const UPSTREAM_MIGRATIONS = [
  '20210105232420_fix_duplicate_title.js',
  '20210106013350_create_t_review.js',
  '20210108093032_alter_t_reviews.js',
  '20210115014202_add_on_delete_cascade.js',
  '20210206135836_drop_t_favorite.js',
  '20210206141840_drop_not_null_constraints.js',
  '20210213224539_alter_t_va.js',
  '20210213233544_fill_va_uuid.js',
  '20210223200240_drop_not_null_constraints.js',
  '20210301141407_fix_title_redundant_chars.js',
  '20210304101412_fix_view_userMetatdata.js',
  '20210305161906_remove_ddl_from_review_api.js',
  '20210307061415_refactor_queries.js',
  '20210502081522_remove_obsolete_view.js',
  '20221231013326_timestamp_for_work.js',
  '20230730170219_play_histroy.js',
  '20231201003918_work_file_memo.js',
  '20260725000001_remove_lyric_status.js',
  '20260731075621_add_illustrator_script_writer_series.js',
  '20260801000000_drop_staticmetadata_view.js',
  '20260802000000_text_ids_and_uuid_labels.js',
  '20260803000000_track_progress.js',
  '20260804000000_rename_play_histroy_to_history.js',
  '20260808000000_session_table.js',
  '20260814000000_merge_va_aliases.js',
  '20260824000000_work_extras.js',
  '20260825000000_merge_tag_aliases.js',
  '20260828000000_canonical_fanza_id.js',
  '20260831000000_index_label_names.js',
  '20260912000000_relpath_track_keys.js',
  '20260913000000_work_file_table.js',
  '20260914000000_drop_work_memo.js',
  '20260915000000_restore_work_circle_fk.js',
  '20260915000001_merge_va_aliases_kotone.js',
];

// knex-migrate builds its connection from the `test` knexfile env, so these
// tests point that env at a throwaway database file instead of the suite's
// shared test/db-test.sqlite3.
const useDatabaseAt = (filename) => {
  const original = knexfile.test.connection.filename;
  knexfile.test.connection.filename = filename;
  return () => {
    knexfile.test.connection.filename = original;
  };
};

const open = (filename) => knexLib({
  client: Client_NodeSQLite,
  connection: { filename },
  useNullAsDefault: true,
});

describe('migration manifest', () => {
  it('lists every migration with its original .js name', () => {
    const names = migrations.map((migration) => migration.name);

    expect(names).to.deep.equal(UPSTREAM_MIGRATIONS);
    for (const name of names) {
      expect(name).to.match(/\.js$/);
    }
    // knex runs the list in order, so it must already be sorted by filename.
    expect([...names].sort()).to.deep.equal(names);
    for (const migration of migrations) {
      expect(migration.up).to.be.a('function');
      expect(migration.down).to.be.a('function');
    }
  });

  describe('with a throwaway database', () => {
    let dir;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiko-migrations-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // A database written by the upstream CommonJS version already holds every
    // migration name. Nothing may run a second time.
    it('migration names stay compatible with upstream databases', async () => {
      const filename = path.join(dir, 'upstream.sqlite3');
      const db = open(filename);
      await db.schema.createTable('knex_migrations', (t) => {
        t.increments();
        t.string('name');
        t.integer('batch');
        t.timestamp('migration_time');
      });
      const now = new Date();
      await db('knex_migrations').insert(UPSTREAM_MIGRATIONS.map((name) => ({
        name,
        batch: 1,
        migration_time: now,
      })));
      const before = await db('knex_migrations').count('* as c').first();
      await db.destroy();

      const progress = [];
      const restore = useDatabaseAt(filename);
      try {
        await knexMigrate('up', {}, (event) => progress.push(event));
      } finally {
        restore();
      }

      expect(progress).to.deep.equal([]);

      const after = open(filename);
      const count = await after('knex_migrations').count('* as c').first();
      await after.destroy();
      expect(count.c).to.equal(before.c);
      expect(count.c).to.equal(UPSTREAM_MIGRATIONS.length);
    });

    // The migrations are incremental from the v0.3.0 schema, so a database
    // with no tables at all cannot be migrated (`init.js` builds a brand-new
    // database from createSchema() and skips the migrations instead). "Fresh"
    // here means the base schema with an empty knex_migrations table, which is
    // what an upstream database looked like before any migration ran.
    it('fresh database migrates to dbVersion', async () => {
      const filename = path.join(dir, 'fresh.sqlite3');
      const restore = useDatabaseAt(filename);
      const db = open(filename);
      try {
        await createOldSchema(db);
        await knexMigrate('up', {});
      } finally {
        await db.destroy();
        restore();
      }

      const verify = open(filename);
      const lastMigration = await verify('knex_migrations').orderBy('id', 'desc').limit(1);
      await verify.destroy();

      expect(dbVersion).to.be.a('string');
      expect(lastMigration[0].name.startsWith(dbVersion)).to.equal(true);
    });
  });
});
