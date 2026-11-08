// Requiring the backfill script pulls in config + database/db; freeze the
// config file so the test run never writes one, as edit-metadata.js does.
process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import knexLib, { type Knex } from 'knex';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';
import { makeQueries } from '../database/queries.ts';
import { runBackfill } from '../scripts/backfill-progress.ts';
import { addWorkFileSchema } from './helpers/schema.ts';

// History rows written since the play-history / track-progress split carry no
// state.seconds at all — the position lives in t_track_progress. The backfill
// used to require state.seconds and skipped those rows entirely.
describe('backfill reads the position from t_track_progress', () => {
  let knex: Knex;
  // The importer's own `dbApi` parameter type; BackfillOptions is not exported.
  let dbApi: NonNullable<Parameters<typeof runBackfill>[0]>['dbApi'];

  // trackId is `${workId}/${relPath}`, and the relPath half is the track_key.
  const track = (workId: string, relPath: string, duration: number) => ({ trackId: `${workId}/${relPath}`, title: relPath, duration });

  beforeEach(async () => {
    knex = knexLib({ client: Client_NodeSQLite, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('t_work', t => {
      t.string('id').primary(); t.string('root_folder'); t.string('dir');
    });
    await knex.schema.createTable('t_play_history', t => {
      t.string('user_name'); t.string('work_id'); t.text('state'); t.timestamp('updated_at');
    });
    await knex.schema.createTable('t_review', t => {
      t.string('user_name'); t.string('work_id'); t.string('progress');
      t.integer('rating'); t.text('review_text'); t.timestamp('updated_at');
    });
    await knex.schema.createTable('t_track_progress', t => {
      t.string('user_name'); t.string('work_id'); t.string('track_key');
      t.float('seconds'); t.boolean('completed'); t.timestamp('updated_at');
      t.unique(['user_name', 'work_id', 'track_key']);
    });
    await addWorkFileSchema(knex);
    await knex('t_work').insert([
      { id: '000001', root_folder: 'root', dir: 'w1' },
      { id: '000002', root_folder: 'root', dir: 'w2' },
    ]);
    dbApi = { knex, ...makeQueries(knex) };
  });

  afterEach(async () => { await knex.destroy(); });

  const run = (dryRun = false) => runBackfill({ dryRun, log: () => {}, dbApi });

  it('marks listened from the progress row of a seconds-less history row', async () => {
    await knex('t_play_history').insert({
      user_name: 'admin', work_id: '000001',
      state: JSON.stringify({ queue: [track('000001', '01.mp3', 600)], index: 0 }),
    });
    await knex('t_track_progress').insert({
      user_name: 'admin', work_id: '000001', track_key: '01.mp3', seconds: 590, completed: 1,
    });

    const summary = await run();
    assert.equal(summary.marked, 1);
    const review = await knex('t_review').where({ user_name: 'admin', work_id: '000001' }).first();
    assert.equal(review.progress, 'listened');
  });

  it('leaves a part-played work alone', async () => {
    await knex('t_play_history').insert({
      user_name: 'admin', work_id: '000001',
      state: JSON.stringify({ queue: [track('000001', '01.mp3', 600)], index: 0 }),
    });
    await knex('t_track_progress').insert({
      user_name: 'admin', work_id: '000001', track_key: '01.mp3', seconds: 120, completed: 0,
    });

    const summary = await run();
    assert.equal(summary.marked, 0);
    assert.equal(await knex('t_review').first(), undefined);
  });

  it('still marks listened from a legacy row that carries its own seconds', async () => {
    await knex('t_play_history').insert({
      user_name: 'admin', work_id: '000002',
      state: JSON.stringify({ queue: [track('000002', '01.mp3', 600)], index: 0, seconds: 599 }),
    });

    const summary = await run();
    assert.equal(summary.marked, 1);
    // ...and seeds the progress row the read path looks up, keyed by the
    // relPath the queue item's trackId already carries — no file read needed.
    const progress = await knex('t_track_progress').where({ work_id: '000002' }).first();
    assert.equal(progress.track_key, '01.mp3');
    assert.equal(progress.seconds, 599);
    assert.equal(progress.completed, 1);
  });

  it('does not seed when there is no position to seed from', async () => {
    await knex('t_play_history').insert({
      user_name: 'admin', work_id: '000001',
      state: JSON.stringify({ queue: [track('000001', '01.mp3', 600)], index: 0 }),
    });

    const summary = await run();
    assert.equal(summary.p2SkippedNoSeconds, 1);
    assert.equal(summary.p2Seeded, 0);
    assert.equal(await knex('t_track_progress').first(), undefined);
  });

  it('writes nothing on a dry run', async () => {
    await knex('t_play_history').insert({
      user_name: 'admin', work_id: '000002',
      state: JSON.stringify({ queue: [track('000002', '01.mp3', 600)], index: 0, seconds: 599 }),
    });

    const summary = await run(true);
    assert.equal(summary.marked, 1);
    assert.equal(summary.p2Seeded, 1);
    assert.equal(await knex('t_review').first(), undefined);
    assert.equal(await knex('t_track_progress').first(), undefined);
  });
});
