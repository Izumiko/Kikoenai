// Requiring the importer pulls in config + database/db; freeze the config file
// so the test run never writes one, as backfill-progress.js's test does.
process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import knexLib, { type Knex } from 'knex';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';
import { makeQueries } from '../database/queries.ts';
import { config } from '../config.ts';
import { runImport } from '../scripts/import-legacy-history.ts';
import { addWorkFileSchema } from './helpers/schema.ts';
import type { RootFolder } from '../types/config.ts';

/**
 * The importer reads the current track list off disk (getTrackList), so these
 * tests lay down a real work folder. The file contents are irrelevant: a track
 * is keyed by its work-relative path, and no file is ever read.
 */
describe('import-legacy-history', () => {
  let knex: Knex;
  let dbApi: { knex: Knex } & ReturnType<typeof makeQueries>;
  let tmpRoot: string;
  let oldDbPath: string;
  let oldKnex: Knex;
  let savedRootFolders: RootFolder[];

  const writeTrack = (relPath: string) => {
    const full = path.join(tmpRoot, 'w1', relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  };

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kiko-import-'));
    savedRootFolders = config.rootFolders;
    config.rootFolders = [{ name: 'root', path: tmpRoot }];

    knex = knexLib({ client: Client_NodeSQLite, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('t_work', t => {
      t.string('id').primary(); t.string('title'); t.string('root_folder'); t.string('dir'); t.text('memo');
    });
    await knex.schema.createTable('t_play_history', t => {
      t.string('user_name'); t.string('work_id'); t.text('state');
      t.timestamp('created_at'); t.timestamp('updated_at');
      t.primary(['user_name', 'work_id']);
    });
    await knex.schema.createTable('t_review', t => {
      t.string('user_name'); t.string('work_id'); t.string('progress');
      t.integer('rating'); t.text('review_text'); t.timestamp('updated_at');
      t.primary(['user_name', 'work_id']);
    });
    await knex.schema.createTable('t_track_progress', t => {
      t.string('user_name'); t.string('work_id'); t.string('track_key');
      t.float('seconds'); t.boolean('completed'); t.timestamp('updated_at');
      t.primary(['user_name', 'work_id', 'track_key']);
    });
    await addWorkFileSchema(knex);
    dbApi = { knex, ...makeQueries(knex) };

    // The legacy database, in the kikoeru-project shape.
    oldDbPath = path.join(tmpRoot, 'old.sqlite3');
    oldKnex = knexLib({ client: Client_NodeSQLite, connection: { filename: oldDbPath }, useNullAsDefault: true });
    await oldKnex.schema.createTable('t_history', t => {
      t.increments('id'); t.string('user_name'); t.string('work_id');
      t.string('file_index'); t.string('file_name');
      t.integer('play_time'); t.integer('total_time');
      t.timestamp('created_at'); t.timestamp('updated_at');
    });
    await oldKnex.schema.createTable('t_review', t => {
      t.string('user_name'); t.string('work_id'); t.integer('rating');
      t.string('review_text'); t.string('progress');
    });
  });

  afterEach(async () => {
    config.rootFolders = savedRootFolders;
    await oldKnex.destroy();
    await knex.destroy();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  type ImportOverrides = Partial<NonNullable<Parameters<typeof runImport>[0]>>;
  const run = (opts: ImportOverrides = {}) => runImport({ oldDbPath, log: () => {}, dbApi, ...opts });

  // Durations live on t_work_file rows now, not in t_work.memo, and the importer
  // reads them from there to tell two identically named mixes apart.
  // files_indexed_at is stamped so listWorkTracks trusts the rows as complete
  // rather than re-walking and overwriting them with NULLs.
  const insertWork = async ({ duration = {} }: { duration?: Record<string, number> } = {}) => {
    await knex('t_work').insert({
      id: '000001', title: 'Work One', root_folder: 'root', dir: 'w1',
      files_indexed_at: duration && Object.keys(duration).length ? new Date().toISOString() : null,
    });
    const rows = Object.entries(duration).map(([rel_path, value]) => ({
      work_id: '000001', rel_path, duration: value, mtime: null, track_title: null,
    }));
    if (rows.length) await knex('t_work_file').insert(rows);
  };

  describe('a re-encoded library (.flac -> .webm)', () => {
    beforeEach(async () => {
      writeTrack('01 intro.webm');
      writeTrack('02 main.webm');
      await insertWork({
        duration: { '01 intro.webm': 60.2, '02 main.webm': 600.4 },
      });
      await oldKnex('t_history').insert([
        { user_name: 'admin', work_id: '1', file_index: '0', file_name: '01 intro.flac', play_time: 59, total_time: 60, created_at: '2023-02-09 06:04:46', updated_at: '2023-02-09 06:04:46' },
        { user_name: 'admin', work_id: '1', file_index: '1', file_name: '02 main.flac', play_time: 120, total_time: 600, created_at: '2023-02-09 06:11:15', updated_at: '2023-02-10 07:00:00' },
      ]);
    });

    it('matches on the basename and seeds per-track progress', async () => {
      const summary = await run();
      assert.equal(summary.matchedRows, 2);
      assert.equal(summary.unmatchedRows, 0);

      const rows = await knex('t_track_progress').orderBy('track_key');
      assert.deepEqual(rows.map(r => [r.track_key, r.seconds, !!r.completed]), [['01 intro.webm', 59, true], ['02 main.webm', 120, false]]);
    });

    it('rebuilds a play-history entry anchored on the last track played', async () => {
      await run();
      const row = await knex('t_play_history').first();
      const state = JSON.parse(row.state);
      assert.equal(state.queue.length, 2);
      assert.equal(state.index, 1);
      assert.equal(state.seconds, 120);
      assert.deepEqual(state.queue[1], {
        trackId: '000001/02 main.webm', title: '02 main.webm',
        duration: 600.4, workTitle: 'Work One',
      });
      // The history list orders by updated_at; a 2023 session must not sort as today.
      assert.equal(row.created_at, '2023-02-09 06:04:46');
      assert.equal(row.updated_at, '2023-02-10 07:00:00');
    });

    it('writes nothing on a dry run', async () => {
      const summary = await run({ dryRun: true });
      assert.equal(summary.progressWritten, 2);
      assert.deepEqual(await knex('t_track_progress').count('* as n').first(), { n: 0 });
      assert.deepEqual(await knex('t_play_history').count('* as n').first(), { n: 0 });
    });

    it('is idempotent: a second run writes nothing new', async () => {
      await run();
      const summary = await run();
      assert.equal(summary.progressWritten, 0);
      assert.equal(summary.playHistoryWritten, 0);
      assert.equal(summary.progressSkipped, 2);
    });

    it('leaves a position the user has set since alone', async () => {
      await knex('t_track_progress').insert({
        user_name: 'admin', work_id: '000001', track_key: '02 main.webm', seconds: 500, completed: 0,
      });
      await run();
      const row = await knex('t_track_progress').where({ track_key: '02 main.webm' }).first();
      assert.equal(row.seconds, 500);
    });
  });

  it('seeds both variants when a name exists in an SE-on and an SE-off folder', async () => {
    writeTrack('SE/01 track.webm');
    writeTrack('noSE/01 track.webm');
    await insertWork({
      duration: { 'SE/01 track.webm': 300, 'noSE/01 track.webm': 300 },
    });
    await oldKnex('t_history').insert({
      user_name: 'admin', work_id: '1', file_index: '0', file_name: '01 track.flac',
      play_time: 150, total_time: 300, created_at: '2023-02-09 06:04:46', updated_at: '2023-02-09 06:04:46',
    });

    await run();
    const rows = await knex('t_track_progress').orderBy('track_key');
    assert.deepEqual(rows.map(r => r.track_key), ['SE/01 track.webm', 'noSE/01 track.webm']);
    // The queue is folder-scoped, so it holds only the anchor's own folder.
    const state = JSON.parse((await knex('t_play_history').first()).state);
    assert.equal(state.queue.length, 1);
  });

  it('picks the variant whose duration matches when the duplicates differ', async () => {
    writeTrack('SE/01 track.webm');
    writeTrack('noSE/01 track.webm');
    await insertWork({
      duration: { 'SE/01 track.webm': 300, 'noSE/01 track.webm': 420 },
    });
    await oldKnex('t_history').insert({
      user_name: 'admin', work_id: '1', file_index: '0', file_name: '01 track.flac',
      play_time: 100, total_time: 420, created_at: '2023-02-09 06:04:46', updated_at: '2023-02-09 06:04:46',
    });

    await run();
    const rows = await knex('t_track_progress');
    assert.deepEqual(rows.map(r => r.track_key), ['noSE/01 track.webm']);
  });

  it('falls back to a unique duration match for a renamed file', async () => {
    writeTrack('Track01 the real name.webm');
    writeTrack('Track02 something else.webm');
    await insertWork({
      duration: { 'Track01 the real name.webm': 913.7, 'Track02 something else.webm': 342.8 },
    });
    await oldKnex('t_history').insert({
      user_name: 'admin', work_id: '1', file_index: '0', file_name: 'Track01.flac',
      play_time: 32, total_time: 913, created_at: '2023-07-23 05:17:51', updated_at: '2023-07-23 05:17:51',
    });

    const summary = await run();
    assert.equal(summary.matchedRows, 1);
    assert.equal((await knex('t_track_progress').first()).track_key, 'Track01 the real name.webm');
  });

  // A library that has not been rescanned is the normal state for someone
  // importing years-old history, and the key comes off the directory listing
  // rather than the memo, so there is nothing to warm first.
  it('keys progress by relPath on a work with no hashes anywhere', async () => {
    writeTrack('01 intro.webm');
    await insertWork({ duration: { '01 intro.webm': 60 } });
    await oldKnex('t_history').insert({
      user_name: 'admin', work_id: '1', file_index: '0', file_name: '01 intro.flac',
      play_time: 59, total_time: 60, created_at: '2023-02-09 06:04:46', updated_at: '2023-02-09 06:04:46',
    });

    const summary = await run();
    assert.equal(summary.progressWritten, 1);

    const row = await knex('t_track_progress').first();
    assert.equal(row.track_key, '01 intro.webm');
    assert.equal(row.seconds, 59);
  });

  it('works with no memo at all, matching purely on the file name', async () => {
    writeTrack('01 intro.webm');
    await insertWork({});
    await oldKnex('t_history').insert({
      user_name: 'admin', work_id: '1', file_index: '0', file_name: '01 intro.flac',
      play_time: 59, total_time: 60, created_at: '2023-02-09 06:04:46', updated_at: '2023-02-09 06:04:46',
    });

    const summary = await run();
    assert.equal(summary.matchedRows, 1);
    assert.equal(summary.progressWritten, 1);
    // No duration anywhere, so completion falls back to the legacy total_time.
    assert.equal(!!(await knex('t_track_progress').first()).completed, true);
  });

  it('gives every queue item a resolvable trackId', async () => {
    writeTrack('01 intro.webm');
    writeTrack('02 main.webm');
    await insertWork({ duration: { '01 intro.webm': 60, '02 main.webm': 600 } });
    await oldKnex('t_history').insert({
      user_name: 'admin', work_id: '1', file_index: '0', file_name: '01 intro.flac',
      play_time: 30, total_time: 60, created_at: '2023-02-09 06:04:46', updated_at: '2023-02-09 06:04:46',
    });

    await run();
    // The resume-from-history path never refetches the tree, so the stored
    // queue has to carry handles the media routes can resolve on their own.
    const state = JSON.parse((await knex('t_play_history').first()).state);
    assert.equal(state.queue.length, 2);
    assert.deepEqual(state.queue.map((q: { trackId: string }) => q.trackId), ['000001/01 intro.webm', '000001/02 main.webm']);
  });

  it('skips a work that is no longer in the library', async () => {
    await oldKnex('t_history').insert({
      user_name: 'admin', work_id: '999999', file_index: '0', file_name: 'x.flac',
      play_time: 1, total_time: 2, created_at: '2023-02-09 06:04:46', updated_at: '2023-02-09 06:04:46',
    });
    const summary = await run();
    assert.equal(summary.worksMissing, 1);
  });

  describe('reviews', () => {
    beforeEach(async () => {
      writeTrack('01 intro.webm');
      await insertWork({
        duration: { '01 intro.webm': 60 },
      });
    });

    it('ports rating and progress, treating rating 0 as unrated', async () => {
      await oldKnex('t_review').insert([
        { user_name: 'admin', work_id: '1', rating: 5, review_text: '', progress: 'listened' },
      ]);
      await run();
      const row = await knex('t_review').first();
      assert.equal(row.rating, 5);
      assert.equal(row.progress, 'listened');
    });

    it('fills only the fields that are currently empty', async () => {
      await knex('t_review').insert({ user_name: 'admin', work_id: '000001', rating: 3 });
      await oldKnex('t_review').insert({ user_name: 'admin', work_id: '1', rating: 5, review_text: '', progress: 'marked' });

      await run();
      const row = await knex('t_review').first();
      assert.equal(row.rating, 3);       // kept
      assert.equal(row.progress, 'marked'); // filled
    });

    it('skips an all-empty legacy review row', async () => {
      await oldKnex('t_review').insert({ user_name: 'admin', work_id: '1', rating: 0, review_text: '', progress: null });
      const summary = await run();
      assert.equal(summary.reviewsWritten, 0);
    });
  });
});
