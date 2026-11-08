// relPath is a file's one identity: its trackId, its media URL and its
// t_track_progress.track_key. These cover the resolution both ways, the legacy
// positional handle that stored play-history queues still carry, and the
// migration that rekeyed them.

process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import knexLib, { type Knex } from 'knex';
import { config } from '../config.ts';
import { run } from '../scripts/rekey-track-progress.ts';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';

import { getTrackList, toTree } from '../filesystem/utils.ts';
import { legacyIndex } from '../routes/utils/track.ts';
import * as migration from '../database/migrations/20260912000000_relpath_track_keys.ts';
import { addWorkFileSchema } from './helpers/schema.ts';
import { makeQueries } from '../database/queries.ts';
import type { RootFolder } from '../types/config.ts';

describe('track identity: relPath', function () {
  let dir: string;

  const write = (relPath: string, body = 'x') => {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiko-track-'));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds a trackId from the work id and the relative path', async function () {
    write('01 intro.mp3');
    write('SE/02 main.mp3');

    const tracks = await getTrackList('000001', dir);
    const byPath = new Map(tracks.map(t => [t.shortFilePath, t.trackId]));

    assert.equal(byPath.get('01 intro.mp3'), '000001/01 intro.mp3');
    assert.equal(byPath.get('SE/02 main.mp3'), '000001/SE/02 main.mp3');
  });

  it('keeps a non-ASCII path intact', async function () {
    write('絶頂トレーニング/01 囁き＆吐息♡.mp3');

    const [track] = await getTrackList('000001', dir);
    assert.equal(track.shortFilePath, '絶頂トレーニング/01 囁き＆吐息♡.mp3');
    assert.equal(track.trackId, '000001/絶頂トレーニング/01 囁き＆吐息♡.mp3');
  });

  // A media URL is the trackId, so a backslashed relPath from a Windows server
  // would key the same file differently and address a path no client can build.
  it('always spells a relPath with forward slashes', async function () {
    write('SE/sub dir/03.mp3');

    const [track] = await getTrackList('000001', dir);
    assert.ok(!track.shortFilePath.includes('\\'));
    assert.equal(track.shortFilePath, 'SE/sub dir/03.mp3');
  });

  it('exposes relPath on every node type, not just audio', async function () {
    write('01 intro.mp3');
    write('cover.jpg');
    write('readme.txt');
    write('booklet.pdf');

    const tracks = await getTrackList('000001', dir);
    const tree = toTree(tracks, 'Work', 'w1', { name: 'root', path: dir });
    const nodes = tree.filter(n => n.type);

    assert.deepEqual(nodes.map(n => n.type).sort(), ['audio', 'image', 'other', 'text']);
    for (const node of nodes) {
      assert.equal(typeof node.relPath, 'string', node.type);
      assert.equal(node.trackId, `000001/${node.relPath}`, node.type);
    }
  });

  // subtitle is forward-slash on every platform, so toTree must split on '/'
  // rather than path.sep -- on a Windows server path.sep is '\', which left a
  // nested folder as one flat node titled "A/B/C".
  it('nests folders regardless of the platform separator', async function () {
    write('A/B/C/01.mp3');
    const tracks = await getTrackList('000001', dir);

    // path.sep is typed read-only, but the test deliberately rewrites it to
    // stand in for a Windows server, so the module object gets a mutable view.
    const mutablePath = path as unknown as { sep: string };
    const sep = path.sep;
    mutablePath.sep = '\\';
    let tree;
    try {
      tree = toTree(tracks, 'Work', 'w1', { name: 'root', path: dir });
    } finally {
      mutablePath.sep = sep;
    }

    const [a] = tree.filter(n => n.type === 'folder');
    assert.equal(a.title, 'A');
    const [b] = a.children!.filter(n => n.type === 'folder');
    assert.equal(b.title, 'B');
    const [c] = b.children!.filter(n => n.type === 'folder');
    assert.equal(c.title, 'C');
    assert.deepEqual(c.children!.map(n => n.title), ['01.mp3']);
  });

  describe('the legacy positional handle', function () {
    it('reads a lone run of digits as an index', function () {
      assert.equal(legacyIndex(['7']), 7);
      assert.equal(legacyIndex(['0']), 0);
    });

    // Every tracked file carries a supported extension, so a real relPath
    // always contains a '.' -- which is what makes the branch unambiguous.
    it('reads anything that could be a real path as a path', function () {
      assert.equal(legacyIndex(['01.mp3']), null);
      assert.equal(legacyIndex(['SE', '7']), null);
      assert.equal(legacyIndex(['7.mp3']), null);
      assert.equal(legacyIndex([]), null);
    });
  });

  describe('migration 20260912000000', function () {
    let knex: Knex;

    beforeEach(async function () {
      knex = knexLib({ client: Client_NodeSQLite, connection: { filename: ':memory:' }, useNullAsDefault: true });
      await knex.schema.createTable('t_work', t => { t.string('id').primary(); t.text('memo'); });
      await knex.schema.createTable('t_play_history', t => {
        t.string('user_name'); t.string('work_id'); t.text('state');
      });
      await knex.schema.createTable('t_track_progress', t => {
        t.string('user_name'); t.string('work_id'); t.string('track_key');
        t.float('seconds'); t.boolean('completed'); t.timestamp('updated_at');
        t.primary(['user_name', 'work_id', 'track_key']);
      });
      await knex('t_work').insert({
        id: '000001',
        memo: JSON.stringify({
          duration: { '01 intro.mp3': 60 },
          contentHash: { '01 intro.mp3': 'aaaaaaaa', 'SE/02 main.mp3': 'bbbbbbbb' },
        }),
      });
    });

    afterEach(async function () { await knex.destroy(); });

    it('rekeys a progress row from its hash to its relPath', async function () {
      await knex('t_track_progress').insert({
        user_name: 'admin', work_id: '000001', track_key: 'bbbbbbbb', seconds: 42, completed: 0,
      });

      await migration.up(knex);

      const row = await knex('t_track_progress').first();
      assert.equal(row.track_key, 'SE/02 main.mp3');
      assert.equal(row.seconds, 42);
    });

    // Never deleted: an older scrapeWorkMemo wiped memo.contentHash on most
    // works (AGENTS.md §2.9a), and the old tree endpoint would recompute the
    // hash and revive the row -- so dropping it here is silent data loss.
    // scripts/rekey-track-progress.js recovers these by reading the files.
    it('keeps a progress row whose hash no longer resolves', async function () {
      await knex('t_track_progress').insert({
        user_name: 'admin', work_id: '000001', track_key: 'deadbeef', seconds: 9, completed: 0,
      });

      await migration.up(knex);

      const row = await knex('t_track_progress').first();
      assert.equal(row.track_key, 'deadbeef');
      assert.equal(row.seconds, 9);
    });

    it('rewrites a queue item trackId and drops its contentHash', async function () {
      await knex('t_play_history').insert({
        user_name: 'admin', work_id: '000001',
        state: JSON.stringify({
          index: 0,
          queue: [{ trackId: '000001/3', contentHash: 'aaaaaaaa', title: '01 intro.mp3' }],
        }),
      });

      await migration.up(knex);

      const state = JSON.parse((await knex('t_play_history').first()).state);
      assert.equal(state.queue[0].trackId, '000001/01 intro.mp3');
      assert.ok(!Object.hasOwn(state.queue[0], 'contentHash'));
    });

    it('folds the pre-rename `hash` field into trackId', async function () {
      await knex('t_play_history').insert({
        user_name: 'admin', work_id: '000001',
        state: JSON.stringify({ index: 0, queue: [{ hash: '000001/3', title: 'unknown.mp3' }] }),
      });

      await migration.up(knex);

      const item = JSON.parse((await knex('t_play_history').first()).state).queue[0];
      // Nothing to resolve it by, so the legacy positional handle is kept --
      // routes/utils/track.js still resolves it.
      assert.equal(item.trackId, '000001/3');
      assert.ok(!Object.hasOwn(item, 'hash'));
    });

    describe('a positional handle with no contentHash', function () {
      interface LegacyQueueItem {
        trackId?: string;
        subtitle?: string | null;
        title?: string;
        hash?: string;
        mediaStreamUrl?: string;
        mediaDownloadUrl?: string;
      }

      const migrate = async (queue: LegacyQueueItem[], workId = '000001'): Promise<LegacyQueueItem[]> => {
        await knex('t_play_history').insert({ user_name: 'admin', work_id: workId, state: JSON.stringify({ index: 0, queue }) });
        await migration.up(knex);
        const state = JSON.parse((await knex('t_play_history').first()).state) as { queue: LegacyQueueItem[] };
        return state.queue;
      };

      beforeEach(async function () {
        await knex('t_work').insert({
          id: '01636129',
          memo: JSON.stringify({ duration: { 'SE/02 main.mp3': 1, 'NoSE/02 main.mp3': 1, 'NoSE/03 end.mp3': 1 } }),
        });
      });

      it('rebuilds the relPath from its folder and title', async function () {
        const [item] = await migrate([{ trackId: '01636129/5', subtitle: 'SE', title: '02 main.mp3' }], '01636129');
        assert.equal(item.trackId, '01636129/SE/02 main.mp3');
      });

      it('matches a folderless title only when the name is unique', async function () {
        const queue = await migrate([
          { trackId: '01636129/1', title: '03 end.mp3' },
          { trackId: '01636129/2', title: '02 main.mp3' },
        ], '01636129');
        assert.deepEqual(queue.map(item => item.trackId), ['01636129/NoSE/03 end.mp3', '01636129/2']);
      });

      it('respells the pre-text-id numeric prefix of its own work', async function () {
        const queue = await migrate([
          { trackId: '1636129/7', subtitle: 'NoSE', title: '03 end.mp3' },
          { trackId: '1636129/9', title: 'gone.flac' },
        ], '01636129');
        assert.deepEqual(queue.map(item => item.trackId), ['01636129/NoSE/03 end.mp3', '01636129/9']);
      });

      it('keeps the old handle when the rebuilt path is not a file the memo knows', async function () {
        const [item] = await migrate([{ trackId: '01636129/5', subtitle: 'SE', title: '02 main.flac' }], '01636129');
        assert.equal(item.trackId, '01636129/5');
      });

      it('drops a default stream URL but keeps an offload one', async function () {
        const queue = await migrate([
          { trackId: '1636129/5', subtitle: 'SE', title: '02 main.mp3', mediaStreamUrl: '/kiko/api/media/stream/1636129/5', mediaDownloadUrl: '/api/media/download/1636129/5' },
          { trackId: '01636129/NoSE/03 end.mp3', mediaStreamUrl: '/media/stream/root/RJ01636129/NoSE/03 end.mp3' },
        ], '01636129');
        assert.ok(!Object.hasOwn(queue[0], 'mediaStreamUrl') && !Object.hasOwn(queue[0], 'mediaDownloadUrl'));
        assert.equal(queue[1].mediaStreamUrl, '/media/stream/root/RJ01636129/NoSE/03 end.mp3');
      });

      it('leaves tracks of another work alone', async function () {
        const [item] = await migrate([{ trackId: '000001/3', subtitle: null, title: '01 intro.mp3' }], '01636129');
        assert.equal(item.trackId, '000001/3');
      });
    });

    it('strips contentHash from the memo once it has been used', async function () {
      await migration.up(knex);

      const memo = JSON.parse((await knex('t_work').first()).memo);
      assert.ok(!Object.hasOwn(memo, 'contentHash'));
      assert.deepEqual(memo.duration, { '01 intro.mp3': 60 });
    });

    it('refuses to roll back rather than pretend it can', async function () {
      let threw = false;
      try {
        await migration.down();
      } catch {
        threw = true;
      }
      assert.equal(threw, true);
    });
  });
});

// The recovery tool for rows migration 20260912000000 had to leave behind.
// CRC32 lives only in that script, so this is the one place it is exercised.
describe('rekey-track-progress (opt-in recovery)', function () {
  let knex: Knex;
  let root: string;
  let savedRootFolders: RootFolder[];

  const hashOf = (body: string) => (zlib.crc32(body) >>> 0).toString(16).padStart(8, '0');

  beforeEach(async function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiko-rekey-'));
    fs.mkdirSync(path.join(root, 'w1'));
    fs.writeFileSync(path.join(root, 'w1', '01 intro.mp3'), 'aaaa');
    savedRootFolders = config.rootFolders;
    config.rootFolders = [{ name: 'root', path: root }];

    knex = knexLib({ client: Client_NodeSQLite, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('t_work', t => {
      t.string('id').primary(); t.string('root_folder'); t.string('dir');
    });
    await knex.schema.createTable('t_track_progress', t => {
      t.string('user_name'); t.string('work_id'); t.string('track_key');
      t.float('seconds'); t.boolean('completed'); t.timestamp('updated_at');
      t.primary(['user_name', 'work_id', 'track_key']);
    });
    await addWorkFileSchema(knex);
    await knex('t_work').insert({ id: '000001', root_folder: 'root', dir: 'w1' });
  });

  afterEach(async function () {
    config.rootFolders = savedRootFolders;
    await knex.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seed = (track_key: string, seconds = 42) => knex('t_track_progress')
    .insert({ user_name: 'admin', work_id: '000001', track_key, seconds, completed: 0 });

  it('recovers a stranded row by hashing the file it names', async function () {
    await seed(hashOf('aaaa'), 77);

    const summary = await run({ log: () => {}, dbApi: { knex, ...makeQueries(knex) } });
    assert.equal(summary.recovered, 1);

    const row = await knex('t_track_progress').first();
    assert.equal(row.track_key, '01 intro.mp3');
    assert.equal(row.seconds, 77);
  });

  it('leaves a row alone when no file matches its hash', async function () {
    await seed('deadbeef');

    const summary = await run({ log: () => {}, dbApi: { knex, ...makeQueries(knex) } });
    assert.equal(summary.unresolved, 1);
    assert.equal((await knex('t_track_progress').first()).track_key, 'deadbeef');
  });

  it('writes nothing on a dry run', async function () {
    await seed(hashOf('aaaa'));

    const summary = await run({ dryRun: true, log: () => {}, dbApi: { knex, ...makeQueries(knex) } });
    assert.equal(summary.recovered, 1);
    assert.equal((await knex('t_track_progress').first()).track_key, hashOf('aaaa'));
  });

  it('discards the leftovers on --purge', async function () {
    await seed('deadbeef');

    const summary = await run({ purge: true, log: () => {}, dbApi: { knex, ...makeQueries(knex) } });
    assert.equal(summary.purged, 1);
    assert.equal(await knex('t_track_progress').first(), undefined);
  });

  it('does nothing when every key is already a relPath', async function () {
    await seed('01 intro.mp3');

    const summary = await run({ log: () => {}, dbApi: { knex, ...makeQueries(knex) } });
    assert.deepEqual(summary, { stale: 0, recovered: 0, purged: 0, unresolved: 0 });
  });
});

// Re-running the migration must not report already-converted rows as stranded:
// by then the memos are stripped, so nothing resolves and a "did not resolve"
// counter would accuse every row it had correctly converted.
describe('migration 20260912000000 re-run', function () {
  let knex: Knex;

  beforeEach(async function () {
    knex = knexLib({ client: Client_NodeSQLite, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('t_work', t => { t.string('id').primary(); t.text('memo'); });
    await knex.schema.createTable('t_play_history', t => {
      t.string('user_name'); t.string('work_id'); t.text('state');
    });
    await knex.schema.createTable('t_track_progress', t => {
      t.string('user_name'); t.string('work_id'); t.string('track_key');
      t.float('seconds'); t.boolean('completed'); t.timestamp('updated_at');
      t.primary(['user_name', 'work_id', 'track_key']);
    });
    // Already migrated: memo stripped, one row converted, one left stranded.
    await knex('t_work').insert({ id: '000001', memo: JSON.stringify({ duration: {} }) });
    await knex('t_track_progress').insert([
      { user_name: 'admin', work_id: '000001', track_key: '01 intro.mp3', seconds: 10, completed: 0 },
      { user_name: 'admin', work_id: '000001', track_key: 'deadbeef', seconds: 20, completed: 0 },
    ]);
  });

  afterEach(async function () { await knex.destroy(); });

  it('counts only genuinely hash-shaped keys as stranded', async function () {
    const lines: string[] = [];
    const log = console.log;
    console.log = (m) => lines.push(String(m));
    try {
      await migration.up(knex);
    } finally {
      console.log = log;
    }
    assert.ok(lines.join('\n').includes('1 left hash-keyed'));
  });

  it('changes nothing on a second pass', async function () {
    const before = await knex('t_track_progress').orderBy('track_key');
    await migration.up(knex);
    const after = await knex('t_track_progress').orderBy('track_key');
    assert.deepEqual(after, before);
  });
});
