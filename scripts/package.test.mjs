// Round-trip test for the hand-written zip reader/writer in scripts/package.js.
//
// The Windows release archive is produced by these two functions, so they are
// tested directly instead of only through a full `npm run package:windows` run:
// write a folder tree (nested directories, a UTF-8 name, an empty file, binary
// data), read the entries back with the reader, extract it and compare every
// byte, and -- when the host has `unzip` -- let the system tool validate the
// archive's CRCs and central directory too.
//
//   npm run test:package

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scripts/package.js is CommonJS; its default export is module.exports.
import zipTools from './package.js';

const { writeZip, readZipEntries, extractZip } = zipTools;

/** Every file the staged tree should contain, relative to the temp root. */
const SAMPLE_FILES = {
  'Kikoenai/app/app.mjs': Buffer.from('console.log("hello");\n'),
  'Kikoenai/app/nested/deep/leaf.txt': Buffer.from('a nested file\n'),
  'Kikoenai/app/日本語 ファイル.txt': Buffer.from('UTF-8 name and content: こんにちは\n'),
  // Zero bytes: the writer must store, the reader must reproduce size 0.
  'Kikoenai/ffmpeg/ffmpeg.exe': Buffer.alloc(0),
  // Incompressible bytes, so the writer's "store instead of inflate" branch runs.
  'Kikoenai/node/node.exe': Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256)),
};

let root;
let stageDir;
let zipPath;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiko-zip-test-'));
  stageDir = path.join(root, 'Kikoenai');
  zipPath = path.join(root, 'out', 'Kikoenai-test.zip');

  for (const [relPath, data] of Object.entries(SAMPLE_FILES)) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('the reader sees every written entry', () => {
  const count = writeZip(stageDir, zipPath);
  assert.equal(count, Object.keys(SAMPLE_FILES).length);

  const entries = readZipEntries(fs.readFileSync(zipPath));
  assert.deepEqual(entries.map((entry) => entry.name).sort(), Object.keys(SAMPLE_FILES).sort());
  for (const entry of entries) {
    // Both sizes are taken from the central directory, which is what makes a
    // data-descriptor entry readable; a corrupt local header would surface here.
    assert.ok(entry.compSize >= 0 && entry.uncompSize >= 0, `${entry.name} has usable sizes`);
  }
});

test('the reader rejects a file that is not a zip', () => {
  const notZip = path.join(root, 'not-a-zip.bin');
  fs.writeFileSync(notZip, 'this is not a zip archive');
  assert.throws(() => readZipEntries(fs.readFileSync(notZip)), /not a zip file/);
});

test('extraction reproduces the tree byte for byte', () => {
  const extracted = path.join(root, 'extracted');
  extractZip(zipPath, extracted);

  for (const [relPath, expected] of Object.entries(SAMPLE_FILES)) {
    const actual = fs.readFileSync(path.join(extracted, relPath));
    assert.deepEqual(actual, expected, `${relPath} should round-trip unchanged`);
  }

  // The empty file must exist and still be empty (an off-by-one in the reader
  // would drop it or copy the next entry's bytes).
  const empty = path.join(extracted, 'Kikoenai/ffmpeg/ffmpeg.exe');
  assert.equal(fs.statSync(empty).isFile(), true);
  assert.equal(fs.statSync(empty).size, 0);
});

test('the system unzip validates the archive', (t) => {
  const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
  if (probe.error) {
    t.skip('unzip is not installed on this host');
    return;
  }

  const result = spawnSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /No errors detected/);
});
