// The node:sqlite-backed knex client must behave like the sqlite3 driver knex
// ran on before. These cases pin the differences a swap can introduce:
// node:sqlite rows have a null prototype, its defaults enable foreign keys and
// reject double-quoted string literals (sqlite3's defaults are the opposite),
// and its StatementSync has no `reader` flag to pick all() over run().

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import knexLib, { type Knex } from 'knex';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';
import * as knexfile from '../database/knexfile.ts';
import { config } from '../config.ts';

describe('node:sqlite knex client', () => {
  let knex: Knex;

  beforeEach(async () => {
    knex = knexLib({
      client: Client_NodeSQLite,
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    await knex.schema.createTable('t', (t) => {
      t.increments('id');
      t.integer('x');
      t.boolean('flag');
      t.timestamp('at');
    });
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('returns plain objects', async () => {
    await knex('t').insert({ x: 1 });
    const row = await knex('t').first();
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.doesNotThrow(() => row.hasOwnProperty('id'));
  });

  it('insert returns [lastID]', async () => {
    assert.deepEqual(await knex('t').insert({ x: 1 }), [1]);
    assert.deepEqual(await knex('t').insert({ x: 2 }), [2]);
  });

  it('update/del return change counts', async () => {
    await knex('t').insert([{ x: 1 }, { x: 2 }, { x: 3 }]);
    assert.equal(await knex('t').where('x', '>', 1).update({ x: 9 }), 2);
    assert.equal(await knex('t').where('x', 9).del(), 2);
  });

  it('foreign keys are off by default', async () => {
    const [pragma] = await knex.raw('pragma foreign_keys');
    assert.equal(pragma.foreign_keys, 0);

    await knex.schema.createTable('parent', (t) => { t.increments('id'); });
    await knex.schema.createTable('child', (t) => {
      t.increments('id');
      t.integer('parent_id').references('id').inTable('parent');
    });
    // The orphan only inserts when the pragma is off.
    await knex('child').insert({ parent_id: 12345 });
    assert.deepEqual(await knex('child').count('* as c').first(), { c: 1 });
  });

  it('accepts double-quoted string literals', async () => {
    const rows = await knex.raw('select "abc" as v');
    assert.equal(rows[0].v, 'abc');
  });

  it('transactions commit and roll back', async () => {
    await knex.transaction(async (trx) => {
      await trx('t').insert({ x: 1 });
    });
    assert.deepEqual(await knex('t').count('* as c').first(), { c: 1 });

    let caught: unknown;
    try {
      await knex.transaction(async (trx) => {
        await trx('t').insert({ x: 2 });
        throw new Error('rollback');
      });
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof Error)) throw new Error('the transaction should have thrown');
    assert.equal(caught.message, 'rollback');
    assert.deepEqual(await knex('t').count('* as c').first(), { c: 1 });
    assert.deepEqual(await knex('t').pluck('x'), [1]);
  });

  it('alterTable dropColumn works', async () => {
    await knex.schema.createTable('dropme', (t) => {
      t.increments('id');
      t.string('keep');
      t.string('drop');
    });
    await knex('dropme').insert({ keep: 'a', drop: 'b' });
    await knex.schema.alterTable('dropme', (t) => { t.dropColumn('drop'); });
    assert.deepEqual(await knex('dropme').first(), { id: 1, keep: 'a' });
  });

  it('booleans and dates bind like sqlite3', async () => {
    const at = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    await knex('t').insert({ flag: true, at });
    const rows = await knex.raw('select flag, at from t');
    assert.equal(rows[0].flag, 1);
    assert.equal(rows[0].at, at.valueOf());
  });
});

// The pragmas are what make the sqlite3 -> node:sqlite swap behave: node:sqlite
// enables foreign keys by default and sqlite3 does not, and knexfile's
// afterCreate is the only place that turns them back on for the app connection.
describe('the application connection (knexfile development env)', () => {
  let dir: string;
  let knex: Knex;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiko-pragma-'));
    // Same config as the real development env, only the file is a throwaway.
    knex = knexLib({
      ...knexfile.development,
      connection: { filename: path.join(dir, 'db.sqlite3') },
    });
  });

  afterEach(async () => {
    await knex.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('turns foreign keys on and applies the configured busy timeout', async () => {
    const [foreignKeys] = await knex.raw('pragma foreign_keys');
    assert.equal(foreignKeys.foreign_keys, 1);

    const [busyTimeout] = await knex.raw('pragma busy_timeout');
    assert.equal(busyTimeout.timeout, config.dbBusyTimeout);
  });
});
