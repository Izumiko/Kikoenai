// Newest *observation* wins, not newest arrival. A write deferred by the offline
// outbox arrives late carrying an old position; ordering by arrival would let it
// clobber a newer one from another device.

process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import knexLib, { type Knex } from 'knex';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';
import { makeQueries } from '../database/queries.ts';

describe('t_track_progress freshness', () => {
  let knex: Knex;
  let queries: ReturnType<typeof makeQueries>;

  const at = (iso: string) => Date.parse(iso);

  beforeEach(async () => {
    knex = knexLib({ client: Client_NodeSQLite, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('t_track_progress', (t) => {
      t.string('user_name'); t.string('work_id'); t.string('track_key');
      t.float('seconds'); t.boolean('completed');
      t.timestamps(true, true);
      t.primary(['user_name', 'work_id', 'track_key']);
    });
    queries = makeQueries(knex);
  });

  afterEach(async () => { await knex.destroy(); });

  const put = (seconds: number, observedAt: number, completed = false) =>
    queries.upsertTrackProgress('admin', '000001', '01 intro.mp3', seconds, completed, observedAt);
  const read = () => queries.getTrackProgress('admin', '000001');

  it('stores the observation time as UTC text, matching every other timestamp', async () => {
    await put(10, at('2026-09-13T06:00:00Z'));
    const row = await knex('t_track_progress').first();
    assert.equal(row.updated_at, '2026-09-13 06:00:00');
  });

  it('accepts a newer observation', async () => {
    await put(10, at('2026-09-13T06:00:00Z'));
    await put(90, at('2026-09-13T07:00:00Z'));
    assert.equal((await read())['000001/01 intro.mp3'].seconds, 90);
  });

  // The outbox case: an hour-old position delivered after a newer one landed.
  it('rejects an older observation that arrives later', async () => {
    await put(90, at('2026-09-13T07:00:00Z'));
    await put(10, at('2026-09-13T06:00:00Z'));
    assert.equal((await read())['000001/01 intro.mp3'].seconds, 90);
  });

  it('accepts a same-second re-report, so a tie favours the later arrival', async () => {
    await put(10, at('2026-09-13T06:00:00Z'));
    await put(11, at('2026-09-13T06:00:00Z'));
    assert.equal((await read())['000001/01 intro.mp3'].seconds, 11);
  });

  it('does not unset completed from a stale write', async () => {
    await put(600, at('2026-09-13T07:00:00Z'), true);
    await put(5, at('2026-09-13T06:00:00Z'), false);
    const row = (await read())['000001/01 intro.mp3'];
    assert.equal(row.completed, true);
    assert.equal(row.seconds, 600);
  });

  // An un-updated client sends no observedAt; it must keep working, and keep
  // winning, exactly as it did before the guard existed.
  it('falls back to server-now when observedAt is omitted', async () => {
    await put(10, at('2026-09-13T06:00:00Z'));
    await queries.upsertTrackProgress('admin', '000001', '01 intro.mp3', 42, false);
    assert.equal((await read())['000001/01 intro.mp3'].seconds, 42);
  });

  it('returns observedAt so a client can compare against a local copy', async () => {
    await put(10, at('2026-09-13T06:00:00Z'));
    assert.equal((await read())['000001/01 intro.mp3'].observedAt, '2026-09-13 06:00:00');
  });

  // Guards the representation trap: SQLite orders every integer below every
  // text value, so epoch ms here would compare as older than any existing row.
  it('never stores an integer in updated_at', async () => {
    await put(10, at('2026-09-13T06:00:00Z'));
    const [{ t }] = await knex.raw("SELECT typeof(updated_at) AS t FROM t_track_progress");
    assert.equal(t, 'text');
  });
});
