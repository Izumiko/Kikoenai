// Canonical Fanza work ids (d215444) and the boundaries that still speak d_215444

process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import knexLib, { type Knex } from 'knex';

import { isFanzaId, isBooksId, canonicalizeWorkId, fanzaCid, workno } from '../work-id.ts';
import { coverFileName, workImageFileName, getFolderList } from '../filesystem/utils.ts';
import * as migration from '../database/migrations/20260828000000_canonical_fanza_id.ts';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';

describe('work-id helpers', function () {
  it('recognises both Fanza spellings, and no DLsite id', function () {
    assert.equal(isFanzaId('d215444'), true);
    assert.equal(isFanzaId('d_215444'), true);
    assert.equal(isFanzaId('123456'), false);
    assert.equal(isFanzaId('01134567'), false);
  });

  it('canonicalizes to the underscore-free form', function () {
    assert.equal(canonicalizeWorkId('d_215444'), 'd215444');
    assert.equal(canonicalizeWorkId('d215444'), 'd215444');
    assert.equal(canonicalizeWorkId('01134567'), '01134567');
  });

  it('rebuilds Fanza\'s own cid for DMM', function () {
    assert.equal(fanzaCid('d215444'), 'd_215444');
    assert.equal(fanzaCid('d_215444'), 'd_215444');
    assert.equal(fanzaCid('123456'), '123456');
  });

  it('keeps on-disk file names in the underscore form', function () {
    // Renaming everyone's cached covers is not worth it; the file name is an
    // external format here, like the DMM URL.
    assert.equal(coverFileName('d215444', 'main'), 'd_215444_img_main.jpg');
    assert.equal(coverFileName('d_215444', 'main'), 'd_215444_img_main.jpg');
    assert.equal(coverFileName('123456', 'main'), 'RJ123456_img_main.jpg');
    assert.equal(workImageFileName('d215444', 'smp', 2), 'd_215444_img_smp2.jpg');
  });

  it('keeps the BJ prefix, which is not implicit the way RJ is', function () {
    assert.equal(isBooksId('BJ635795'), true);
    assert.equal(isBooksId('bj635795'), true);
    assert.equal(isBooksId('635795'), false);
    assert.equal(isBooksId('d215444'), false);
    assert.equal(canonicalizeWorkId('bj635795'), 'BJ635795');
    // Without the prefix these two works would share a primary key.
    assert.notEqual(canonicalizeWorkId('BJ635795'), canonicalizeWorkId('635795'));
    assert.equal(coverFileName('BJ635795', 'main'), 'BJ635795_img_main.jpg');
    assert.equal(workImageFileName('BJ635795', 'smp', 2), 'BJ635795_img_smp2.jpg');
  });

  it('spells every work code the way its store does', function () {
    assert.equal(workno('635795'), 'RJ635795');
    assert.equal(workno('01134567'), 'RJ01134567');
    assert.equal(workno('BJ635795'), 'BJ635795');
    assert.equal(workno('d215444'), 'd_215444');
  });
});

describe('getFolderList() work-code detection', function () {
  let root: string;

  const scan = async () => {
    const found: string[] = [];
    for await (const folder of getFolderList({ name: 'test', path: root })) found.push(folder.id);
    return found.sort();
  };

  before(() => {
    root = mkdtempSync(join(import.meta.dirname, 'folders-'));
    for (const name of [
      'RJ123456 タイトル',      // DLsite
      'd_215444',               // Fanza, its own spelling
      'd987654 タイトル',       // Fanza, underscore-free
      '[FANZA] d_111222',       // Fanza, prefixed
      'BJ635795 楓と鈴',        // DLsite books floor
      'BJ01622225',             // books, 8-digit
      'Sound_CD1',              // NOT a work code
    ]) mkdirSync(join(root, name));
  });

  after(function () {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('reads both Fanza spellings and yields the canonical id', async function () {
    // Sound_CD1 is not a work folder, so it is recursed into (and is empty).
    assert.deepEqual(await scan(), ['123456', 'BJ01622225', 'BJ635795', 'd111222', 'd215444', 'd987654'].sort());
  });
});

describe('migration 20260828000000 (d_215444 → d215444)', { timeout: 10000 }, () => {
  const TEST_DB = join(import.meta.dirname, 'db-workid-test.sqlite3');
  let knex: Knex;

  const ids = () => knex('t_work').pluck('id').orderBy('id');

  before(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    knex = knexLib({
      client: Client_NodeSQLite, useNullAsDefault: true, connection: { filename: TEST_DB },
    });
    await knex.schema.createTable('t_work', t => { t.string('id'); t.string('title'); });
    await knex.schema.createTable('r_tag_work', t => { t.string('tag_id'); t.string('work_id'); });
    await knex.schema.createTable('t_review', t => { t.string('work_id'); t.integer('rating'); });
    await knex('t_work').insert([{ id: 'd_215444', title: 'Fanza' }, { id: '123456', title: 'DLsite' }]);
    await knex('r_tag_work').insert([{ tag_id: 'x', work_id: 'd_215444' }, { tag_id: 'x', work_id: '123456' }]);
    await knex('t_review').insert([{ work_id: 'd_215444', rating: 5 }]);
  });

  after(async function () {
    if (knex) await knex.destroy();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('rewrites every work-id column, leaving DLsite ids alone', async function () {
    await migration.up(knex);
    assert.deepEqual(await ids(), ['123456', 'd215444']);
    assert.deepEqual(await knex('r_tag_work').pluck('work_id').orderBy('work_id'), ['123456', 'd215444']);
    assert.deepEqual(await knex('t_review').pluck('work_id'), ['d215444']);
  });

  it('reverses cleanly', async function () {
    await migration.down(knex);
    assert.deepEqual(await ids(), ['123456', 'd_215444']);
    assert.deepEqual(await knex('t_review').pluck('work_id'), ['d_215444']);
    await migration.up(knex); // leave it migrated
  });
});
