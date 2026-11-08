// getTrackProgress and applyTrackProgressSeconds are two shapes over one query
// (trackProgressFor). They drifted once already -- the first selected updated_at
// and the second did not, so the work page's file tree and its info panel
// disagreed about the same position. These assert they cannot disagree again.

process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import knexLib, { type Knex } from 'knex';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';
import { makeQueries } from '../database/queries.ts';

describe('the two track-progress projections agree', () => {
  let knex: Knex;
  let queries: ReturnType<typeof makeQueries>;

  beforeEach(async () => {
    knex = knexLib({ client: Client_NodeSQLite, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('t_track_progress', (t) => {
      t.string('user_name'); t.string('work_id'); t.string('track_key');
      t.float('seconds'); t.boolean('completed');
      t.timestamps(true, true);
      t.primary(['user_name', 'work_id', 'track_key']);
    });
    queries = makeQueries(knex);
    await queries.upsertTrackProgress('admin', '000001', 'SE/01 intro.mp3', 123.5,
      true, Date.parse('2026-09-13T06:00:00Z'));
  });

  afterEach(async () => { await knex.destroy(); });

  const historyRow = () => ({
    work_id: '000001',
    state: JSON.stringify({ queue: [{ trackId: '000001/SE/01 intro.mp3' }], index: 0 }),
  });

  it('report the same seconds for the same track', async () => {
    const map = await queries.getTrackProgress('admin', '000001');
    const rows = [historyRow()];
    await queries.applyTrackProgressSeconds('admin', rows);

    const fromMap = map['000001/SE/01 intro.mp3'];
    const fromJoin = JSON.parse(rows[0].state!);
    assert.equal(fromMap.seconds, 123.5);
    assert.equal(fromJoin.seconds, fromMap.seconds);
  });

  // The asymmetry that existed: the map carried observedAt, the join did not.
  it('report the same observedAt for the same track', async () => {
    const map = await queries.getTrackProgress('admin', '000001');
    const rows = [historyRow()];
    await queries.applyTrackProgressSeconds('admin', rows);

    const fromJoin = JSON.parse(rows[0].state!);
    assert.equal(map['000001/SE/01 intro.mp3'].observedAt, '2026-09-13 06:00:00');
    assert.equal(fromJoin.secondsObservedAt, map['000001/SE/01 intro.mp3'].observedAt);
  });

  it('both key on the relPath, not on a positional handle', async () => {
    const map = await queries.getTrackProgress('admin', '000001');
    assert.deepEqual(Object.keys(map), ['000001/SE/01 intro.mp3']);
  });

  it('leave a history row alone when the track has no progress row', async () => {
    const rows = [{
      work_id: '000002',
      state: JSON.stringify({ queue: [{ trackId: '000002/nope.mp3' }], index: 0, seconds: 7 }),
    }];
    await queries.applyTrackProgressSeconds('admin', rows);
    const state = JSON.parse(rows[0].state!);
    assert.equal(state.seconds, 7);
    assert.ok(!Object.hasOwn(state, 'secondsObservedAt'));
  });

  it('do not leak one work\'s position into another with the same relPath', async () => {
    await queries.upsertTrackProgress('admin', '000002', 'SE/01 intro.mp3', 999,
      false, Date.parse('2026-09-13T07:00:00Z'));

    const first = await queries.getTrackProgress('admin', '000001');
    const second = await queries.getTrackProgress('admin', '000002');
    assert.equal(first['000001/SE/01 intro.mp3'].seconds, 123.5);
    assert.equal(second['000002/SE/01 intro.mp3'].seconds, 999);
  });
});
