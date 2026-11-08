// This test checks whether migration from 0.3.0 works
// There is no easy way to check verify that the schema after the migration is the same as the one created from scratch by createSchema()
// Every time when I finish checking the schema I set dbVersion in schema.js to the number in the latest migration file

// Prevent writing config files (side effect of config.js)
process.env.FREEZE_CONFIG_FILE = '1';
process.env.NODE_ENV='test';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'fs';
import { join } from 'path';

import { knex as db } from '../database/db.ts';
import knexMigrate from '../database/knex-migrate.ts';
import type { KnexMigrateProgress } from '../database/knex-migrate.ts';
import { dbVersion } from '../database/schema.ts';
import * as spinup030 from './spinup/spinup-0.3.0.ts';
import * as spinup060rc4 from './spinup/spinup-0.6.0-rc4.ts';
import { dropDatabase } from './teardown/teardown-0.6.0.ts';

describe('Database', function() {
  before(async () => {
    await spinup030.createOldSchema();
  });

  it('v0.3.0 should work', async function() {
    const result = await db.raw(`pragma table_info('t_va')`);
    // t_va id column type was integer in 0.3.0
    assert.equal(result[0]['type'].toLowerCase(), 'integer'.toLowerCase());
  });

  it('should be able to migrate to latest', async function() {
    const log = ({ action, migration }: KnexMigrateProgress) => console.log('Doing ' + action + ' on ' + migration);
    await knexMigrate('up', {}, log);
  });

  it('schema after migration', async function() {
    // There is no easy way to verify that the schema after the migration is the same as the one created from scratch by createSchema()
    // There were some mistakes in previous migrations causing inconsistencies like 'text' vs 'varchar(255)'
    // Most inconsistencies do not cause bugs, because of SQLite type affinity. For example, SQLite stores all string types in 'text' and ignores the 255 limit.
    // You will have to read and verify manually
    // const schema = await db.raw('select sql from sqlite_master where sql not NULL');
    // console.log(schema);

    const tableNames = (await db.raw(`SELECT name FROM sqlite_master WHERE type ='table' AND name NOT LIKE 'sqlite_%'`)).map((record: { name: string }) => record['name']);
    console.log(tableNames);

    for (const table of tableNames) {
      console.log(table);
      const tableInfo = await db.raw(`pragma table_info(${table})`);
      console.table(tableInfo);
    }

    // Every time when I finish checking the schema I set dbVersion in schema.js to the number in the last migration file
    // e.g. '20210307061415'
    // I use this test to prevent me from making mistakes
    // If you want to fork this code and don't understand how this works, just comment out the following lines
    const lastMigration = await db.raw('select name from knex_migrations order by id desc limit 1');
    assert.equal(typeof dbVersion, 'string');
    assert.ok(lastMigration[0].name.startsWith(dbVersion));
  });

  after(async () => {
    await dropDatabase();
  });
});

describe('Database v0.6.0-rc4', function() {
  before(async () => {
    await spinup060rc4.createOldSchema();
    await knexMigrate('skipAll', {to: '20210213233544_fill_va_uuid'});
  });

  it('should work', async function() {
    const result = await db.raw(`pragma table_info('t_va')`);
    // t_va id column type has changed to text in v0.6.0-rc4
    assert.equal(result[0]['type'], 'varchar(255)');
  });

  it('should be able to migrate to 20210502081522_remove_obsolete_view', async function() {
    const log = ({ action, migration }: KnexMigrateProgress) => console.log('Doing ' + action + ' on ' + migration);
    await knexMigrate('up', { to: '20210502081522' }, log);
  });

  it('should have null constraints removed', async function() {
    const tableInfo = await db.raw(`pragma table_info('t_work')`);
    console.table(tableInfo);
    for (const field of tableInfo) {
      if (field['name'] === 'dl_count') {
        assert.equal(field['notnull'], 0);
      }
    }
  });

  after(async () => {
    await db.destroy();
    await new Promise<void>((resolve, reject) => {
      unlink(join(import.meta.dirname, 'db-test.sqlite3'), (err) => {
        if (err) reject(err); else resolve();
      });
    });
  });
});