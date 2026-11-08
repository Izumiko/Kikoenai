// A work's file listing comes from t_work_file now, not from walking the folder
// on every request. These pin the two properties that would break quietly:
// the order must match what the walk produced, and a work must be walked once
// and then never again.

process.env.FREEZE_CONFIG_FILE = '1';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import knexLib, { type Knex } from 'knex';
import Client_NodeSQLite from '../database/node-sqlite-client.ts';

import { makeQueries } from '../database/queries.ts';
import { getTrackList } from '../filesystem/utils.ts';
import { listWorkTracks, indexWorkFiles } from '../filesystem/workFiles.ts';
import { addWorkFileSchema } from './helpers/schema.ts';

describe('work file listing (t_work_file)', () => {
  let knex: Knex;
  let dbApi: { knex: Knex } & ReturnType<typeof makeQueries>;
  let root: string;
  let workDir: string;

  const write = (relPath: string, body = 'x') => {
    const full = path.join(workDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiko-wf-'));
    workDir = path.join(root, 'w1');
    fs.mkdirSync(workDir);

    knex = knexLib({ client: Client_NodeSQLite, connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('t_work', (t) => {
      t.string('id').primary(); t.string('root_folder'); t.string('dir');
    });
    await addWorkFileSchema(knex);
    await knex('t_work').insert({ id: '000001', root_folder: 'root', dir: 'w1' });
    dbApi = { knex, ...makeQueries(knex) };
  });

  afterEach(async () => {
    await knex.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // The order decides the order of every file tree in the UI, and it used to be
  // whatever natural-orderby made of the walked list. Drift here is invisible
  // until someone notices their tracks are shuffled.
  it('orders identically to the filesystem walk', async () => {
    write('02 second.mp3');
    write('01 first.mp3');
    write('10 tenth.mp3');          // natural order: 10 after 2, not after 1
    write('SE/01 first.mp3');
    write('SE/02 second.mp3');
    write('絶頂/01 囁き♡.mp3');
    write('cover.jpg');
    write('notes.txt');

    const walked = (await getTrackList('000001', workDir)).map((t) => t.trackId);
    const listed = (await listWorkTracks('000001', workDir, { dbApi })).map((t) => t.trackId);

    assert.deepEqual(listed, walked);
  });

  it('carries every tracked file type, not just audio', async () => {
    write('01.mp3'); write('01.lrc'); write('cover.jpg'); write('booklet.pdf'); write('notes.txt');

    const listed = await listWorkTracks('000001', workDir, { dbApi });
    assert.deepEqual(listed.map((t) => t.shortFilePath).sort(), ['01.lrc', '01.mp3', 'booklet.pdf', 'cover.jpg', 'notes.txt']);
  });

  it('indexes once, then reads without touching the filesystem', async () => {
    write('01.mp3');
    await listWorkTracks('000001', workDir, { dbApi });

    const stamped = await knex('t_work').select('files_indexed_at').where('id', '000001').first();
    assert.notEqual(stamped.files_indexed_at, null, 'files_indexed_at is stamped');

    // Delete the folder outright: a second read that still answers proves it is
    // not walking. This is also the unmounted-NAS case.
    fs.rmSync(workDir, { recursive: true, force: true });
    const again = await listWorkTracks('000001', workDir, { dbApi });
    assert.deepEqual(again.map((t) => t.shortFilePath), ['01.mp3']);
  });

  it('does not re-walk a work that is genuinely empty', async () => {
    const listed = await listWorkTracks('000001', workDir, { dbApi });
    assert.deepEqual(listed, []);
    const stamped = await knex('t_work').select('files_indexed_at').where('id', '000001').first();
    assert.notEqual(stamped.files_indexed_at, null, 'an empty work is still marked indexed');
  });

  // Durations cost an ffprobe each and track titles cost a model call, so the
  // indexer must carry existing rows forward rather than write NULLs over them.
  // This used to come from t_work.memo; the rows are the only source now.
  it('carries durations and track titles forward when a new file appears', async () => {
    write('01.mp3');
    await dbApi.replaceWorkFiles('000001', [
      { work_id: '000001', rel_path: '01.mp3', duration: 61.5, mtime: 1, track_title: 'Opening' },
    ]);

    // A second file shows up, so the listing is rebuilt around it.
    write('02.mp3');
    const listed = await listWorkTracks('000001', workDir, { dbApi, indexedAt: null });
    const byPath = new Map(listed.map((t) => [t.shortFilePath, t]));

    assert.equal(byPath.get('01.mp3')!.duration, 61.5);
    assert.equal(byPath.get('01.mp3')!.trackTitle, 'Opening');
    // The new one has no duration until a scan probes it -- a request never does.
    assert.equal(byPath.get('02.mp3')!.duration, undefined);
  });

  it('preserves a stored duration when re-indexing without one', async () => {
    write('01.mp3');
    await dbApi.replaceWorkFiles('000001', [
      { work_id: '000001', rel_path: '01.mp3', duration: 99, mtime: 1, track_title: 'Kept' },
    ]);

    await indexWorkFiles('000001', workDir, undefined, dbApi);
    const [row] = await dbApi.getWorkFiles('000001');
    assert.equal(row!.duration, 99);
    assert.equal(row!.track_title, 'Kept');
  });

  it('drops rows for files that are gone after a re-index', async () => {
    write('01.mp3'); write('02.mp3');
    await listWorkTracks('000001', workDir, { dbApi });

    fs.rmSync(path.join(workDir, '02.mp3'));
    await indexWorkFiles('000001', workDir, undefined, dbApi);

    const rows = await dbApi.getWorkFiles('000001');
    assert.deepEqual(rows.map((r) => r.rel_path), ['01.mp3']);
  });

  // The write path behind PUT /api/work/:id/file-metadata.
  it('sets and clears track titles by relPath', async () => {
    write('01.mp3'); write('02.mp3');
    await listWorkTracks('000001', workDir, { dbApi });

    assert.equal(await dbApi.setTrackTitles('000001', { '01.mp3': 'Opening', '02.mp3': 'Ending' }), 2);
    // An empty field in the editor arrives as null and shows the filename again.
    assert.equal(await dbApi.setTrackTitles('000001', { '02.mp3': null }), 1);

    const byPath = new Map((await dbApi.getWorkFiles('000001')).map((r) => [r.rel_path, r]));
    assert.equal(byPath.get('01.mp3')!.track_title, 'Opening');
    assert.equal(byPath.get('02.mp3')!.track_title, null);
  });

  it('leaves another work\'s rows alone', async () => {
    write('01.mp3');
    await listWorkTracks('000001', workDir, { dbApi });

    assert.equal(await dbApi.setTrackTitles('000002', { '01.mp3': 'Wrong work' }), 0);
    const [row] = await dbApi.getWorkFiles('000001');
    assert.equal(row!.track_title, null);
  });

  it('only attaches duration to audio, matching the walk', async () => {
    write('01.mp3'); write('cover.jpg');
    await dbApi.replaceWorkFiles('000001', [
      { work_id: '000001', rel_path: '01.mp3', duration: 10, mtime: 1, track_title: null },
    ]);

    const listed = await listWorkTracks('000001', workDir, { dbApi, indexedAt: null });
    const cover = listed.find((t) => t.shortFilePath === 'cover.jpg');
    assert.ok(!Object.hasOwn(cover!, 'duration'));
  });
});
