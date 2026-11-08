#!/usr/bin/env node
// Kikoenai Windows portable packager.
//
// Stages a self-contained Kikoenai/ folder and zips it:
//
//   Kikoenai/
//     node/node.exe            pinned Node 26 win-x64 runtime
//     app/                     = backend/build/ (the esbuild bundle + dist/ + static/)
//     ffmpeg/ffmpeg.exe        standalone ffmpeg/ffprobe (BtbN GPL build)
//     ffmpeg/ffprobe.exe
//     Kikoenai.bat             launcher (sets KIKO_DATA_DIR + NODE_ENV)
//
// The user unzips it and double-clicks Kikoenai.bat; no Node/ffmpeg on PATH
// needed. Nothing in the bundle is native, so this runs on ANY host OS and the
// only Windows binaries are downloaded prebuilt.
//
//   npm run package:windows
//
// Output: package/dist/Kikoenai-windows-x64-<version>.zip
//
// Offline structure verification (no network needed):
//   KIKO_SKIP_DOWNLOAD=1     skip the downloads and stage empty placeholder
//                            executables, so the folder layout can be checked
//                            without network access (NOT a usable package).
//   KIKO_NODE_ZIP=<path>     use a local Node win-x64 .zip instead of downloading.
//   KIKO_FFMPEG_ZIP=<path>   use a local ffmpeg win64 .zip instead of downloading.
//
// Stdlib only -- no dependencies, and the zip is written/read by hand so the
// script works identically on Linux, macOS and Windows.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const BUILD_DIR = path.join(BACKEND, 'build');
const pkgVersion = require(path.join(BACKEND, 'package.json')).version;
// CI passes the triggering git tag (vX.Y.Z) via PACKAGE_VERSION for tag builds;
// strip the leading "v" to match the package.json semver shape. Fall back to
// backend/package.json for local / workflow_dispatch runs where tags drift.
const tagVersion = process.env.PACKAGE_VERSION;
const VERSION = tagVersion
  ? (tagVersion.startsWith('v') ? tagVersion.slice(1) : tagVersion)
  : pkgVersion;

// Pinned for reproducibility. Bump here when upgrading the shipped runtime.
// Node 26 LTS (Lithium).
const NODE_VERSION = 'v26.13.0';
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;
// BtbN GPL build -- license-compatible with GPL-3.0. `latest` tag is auto-refreshed;
// only ffmpeg.exe + ffprobe.exe are extracted into ffmpeg/.
const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

const STAGE_ROOT = path.join(ROOT, 'package', 'windows');
const STAGE = path.join(STAGE_ROOT, 'Kikoenai');
const APP_DIR = path.join(STAGE, 'app');
const DIST_DIR = path.join(ROOT, 'package', 'dist');
const ZIP_OUT = path.join(DIST_DIR, `Kikoenai-windows-x64-${VERSION}.zip`);

const skipDownload = process.env.KIKO_SKIP_DOWNLOAD === '1';

function npm(args) {
  console.log('$ npm', args.join(' '));
  // On Windows npm is a .cmd shim, which Node can only spawn through a shell.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function placeholder(file) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, '');
  console.log(`  ! KIKO_SKIP_DOWNLOAD=1 -- staged empty placeholder ${path.relative(STAGE, file)}`);
}

function findFile(dir, name) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (ent.name === name) return p;
  }
  return null;
}

// ── minimal ZIP reader (extraction) ────────────────────────────────────────
// `tar` on Linux cannot read zip, and unzip/python are not guaranteed on every
// host, so extraction is done here from the central directory. Handles stored
// and deflated entries, data descriptors (sizes taken from the central
// directory) and the zip64 size/offset fields.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`corrupt zip: bad central directory entry #${i}`);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The zip64 extra field (id 0x0001) holds, in order, only the values whose
    // 32-bit field is 0xFFFFFFFF.
    let extra = p + 46 + nameLen;
    const extraEnd = extra + extraLen;
    while (extra + 4 <= extraEnd) {
      const id = buf.readUInt16LE(extra);
      const size = buf.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let q = extra + 4;
        if (uncompSize === 0xffffffff) { uncompSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      extra += 4 + size;
    }

    entries.push({ name, method, compSize, uncompSize, localOffset });
    p = extraEnd + commentLen;
  }
  return entries;
}

function extractZip(zipFile, destDir) {
  const buf = fs.readFileSync(zipFile);
  for (const entry of readZipEntries(buf)) {
    // Directory entries carry no data; the file writes below create the dirs.
    if (entry.name.endsWith('/')) continue;
    if (buf.readUInt32LE(entry.localOffset) !== LOC_SIG) {
      throw new Error(`corrupt zip: bad local header for ${entry.name}`);
    }
    const nameLen = buf.readUInt16LE(entry.localOffset + 26);
    const extraLen = buf.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compSize);

    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
    if (data.length !== entry.uncompSize) {
      throw new Error(`corrupt zip: ${entry.name} inflated to ${data.length} bytes, expected ${entry.uncompSize}`);
    }

    // Never let an archive entry escape the extraction directory.
    const parts = entry.name.split('/').filter((part) => part && part !== '.' && part !== '..');
    const target = path.join(destDir, ...parts);
    mkdir(path.dirname(target));
    fs.writeFileSync(target, data);
  }
}

// ── minimal ZIP writer (packaging) ─────────────────────────────────────────
// `tar -a -cf` only makes zips on some hosts (bsdtar), so the archive is
// written here instead: stored/deflated entries, UTF-8 names, one top folder.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair (local time, 2-second resolution). */
function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function collectFiles(dir, prefix, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${prefix}${ent.name}`;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(full, `${name}/`, out);
    else out.push({ name, data: fs.readFileSync(full) });
  }
  return out;
}

function writeZip(srcDir, outFile) {
  const top = path.basename(srcDir);
  const files = collectFiles(srcDir, `${top}/`, []);
  const now = dosDateTime(new Date());

  mkdir(path.dirname(outFile));
  rm(outFile);
  const fd = fs.openSync(outFile, 'w');
  // Central-directory records are kept in memory (46 bytes + name each); the
  // file bodies are streamed straight to disk so a 150 MB ffmpeg.exe does not
  // have to sit in the archive buffer too.
  const central = [];
  let offset = 0;

  try {
    for (const file of files) {
      const name = Buffer.from(file.name, 'utf8');
      const deflated = zlib.deflateRawSync(file.data, { level: 9 });
      // Store incompressible data as-is instead of inflating it.
      const useDeflate = deflated.length < file.data.length;
      const body = useDeflate ? deflated : file.data;
      const method = useDeflate ? 8 : 0;
      const crc = crc32(file.data);
      for (const size of [body.length, file.data.length, offset]) {
        if (size > 0xffffffff) throw new Error(`${file.name} is too large for a non-zip64 archive`);
      }

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOC_SIG, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(now.time, 10);
      local.writeUInt16LE(now.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(file.data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28); // extra field length
      fs.writeSync(fd, local);
      fs.writeSync(fd, name);
      fs.writeSync(fd, body);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(CEN_SIG, 0);
      entry.writeUInt16LE(20, 4); // version made by (MS-DOS/FAT)
      entry.writeUInt16LE(20, 6); // version needed
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(method, 10);
      entry.writeUInt16LE(now.time, 12);
      entry.writeUInt16LE(now.date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(file.data.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt16LE(0, 30); // extra field length
      entry.writeUInt16LE(0, 32); // comment length
      entry.writeUInt16LE(0, 34); // disk number start
      entry.writeUInt16LE(0, 36); // internal attributes
      entry.writeUInt32LE(0, 38); // external attributes
      entry.writeUInt32LE(offset, 42);
      central.push(entry, name);

      offset += local.length + name.length + body.length;
    }

    const centralStart = offset;
    for (const chunk of central) {
      fs.writeSync(fd, chunk);
      offset += chunk.length;
    }
    const centralSize = offset - centralStart;
    if (files.length > 0xffff || centralStart > 0xffffffff || centralSize > 0xffffffff) {
      throw new Error('archive too large for a non-zip64 zip');
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // this disk
    eocd.writeUInt16LE(0, 6); // disk with central directory
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20); // comment length
    fs.writeSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }

  return files.length;
}

// ── staging ────────────────────────────────────────────────────────────────

async function download(url, destFile, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    console.log(`downloading ${url}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
      // The whole body is buffered before anything is written, so a failed or
      // truncated download never leaves a half-file behind for the retry.
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destFile, buf);
      console.log(`  -> ${destFile} (${(buf.length / 1e6).toFixed(1)} MB)`);
      return;
    } catch (err) {
      // The ffmpeg zip is ~200 MB; one dropped connection should not fail a
      // release build.
      if (attempt >= attempts) throw err;
      console.warn(`  ! ${err.message} -- retrying`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

/**
 * Return a local path to the archive: the env override when set, otherwise a
 * fresh download into the staging temp directory.
 */
async function acquire(localZip, url, destFile) {
  if (localZip) {
    if (!fs.existsSync(localZip)) throw new Error(`archive not found: ${localZip}`);
    console.log(`using local archive ${localZip}`);
    return localZip;
  }
  await download(url, destFile);
  return destFile;
}

function stageApp() {
  console.log('staging app/ <- backend/build/');
  if (!fs.existsSync(path.join(BUILD_DIR, 'app.mjs'))) {
    throw new Error('backend/build/app.mjs is missing; run `npm run build` first (this script does it).');
  }
  mkdir(APP_DIR);
  fs.cpSync(BUILD_DIR, APP_DIR, { recursive: true });
  if (!fs.existsSync(path.join(APP_DIR, 'dist', 'index.html'))) {
    console.warn('  ! app/dist/index.html is missing -- the package has no WebApp.');
  }
}

async function stageNode(tmp) {
  const target = path.join(STAGE, 'node', 'node.exe');
  mkdir(path.dirname(target));
  if (skipDownload) { placeholder(target); return; }

  const zip = await acquire(process.env.KIKO_NODE_ZIP, NODE_URL, path.join(tmp, 'node.zip'));
  const extracted = path.join(tmp, 'node');
  extractZip(zip, extracted);
  const nodeExe = findFile(extracted, 'node.exe');
  if (!nodeExe) throw new Error('node.exe not found in the Node zip');
  fs.copyFileSync(nodeExe, target);
  console.log(`  staged node/node.exe (${NODE_VERSION} win-x64)`);
}

async function stageFfmpeg(tmp) {
  const dir = path.join(STAGE, 'ffmpeg');
  mkdir(dir);
  if (skipDownload) {
    placeholder(path.join(dir, 'ffmpeg.exe'));
    placeholder(path.join(dir, 'ffprobe.exe'));
    return;
  }

  const zip = await acquire(process.env.KIKO_FFMPEG_ZIP, FFMPEG_URL, path.join(tmp, 'ffmpeg.zip'));
  const extracted = path.join(tmp, 'ffmpeg');
  extractZip(zip, extracted);
  const ffmpeg = findFile(extracted, 'ffmpeg.exe');
  const ffprobe = findFile(extracted, 'ffprobe.exe');
  if (!ffmpeg || !ffprobe) throw new Error('ffmpeg.exe/ffprobe.exe not found in the ffmpeg zip');
  fs.copyFileSync(ffmpeg, path.join(dir, 'ffmpeg.exe'));
  fs.copyFileSync(ffprobe, path.join(dir, 'ffprobe.exe'));
  console.log('  staged ffmpeg/{ffmpeg,ffprobe}.exe');
}

function stageLauncher() {
  const bat = path.join(ROOT, 'scripts', 'launchers', 'Kikoenai.bat');
  fs.copyFileSync(bat, path.join(STAGE, 'Kikoenai.bat'));
  console.log('staged Kikoenai.bat');
}

async function main() {
  console.log(`Packaging Kikoenai ${VERSION} for Windows x64`);
  if (skipDownload) console.warn('\n! KIKO_SKIP_DOWNLOAD=1: the executables are placeholders, not a usable package.\n');

  // 1. Build the frontend (-> backend/dist) and the backend bundle (-> backend/build)
  console.log('\n== 1. build ==');
  npm(['run', 'build']);

  // 2. Stage the portable folder
  console.log('\n== 2. stage ==');
  rm(STAGE_ROOT);
  mkdir(STAGE);
  stageApp();
  const tmp = path.join(STAGE_ROOT, '.tmp');
  mkdir(tmp);
  await stageNode(tmp);
  await stageFfmpeg(tmp);
  stageLauncher();
  rm(tmp);

  // 3. Zip
  console.log('\n== 3. zip ==');
  const count = writeZip(STAGE, ZIP_OUT);
  console.log(`\nDone: ${ZIP_OUT} (${count} files, ${(fs.statSync(ZIP_OUT).size / 1e6).toFixed(1)} MB)`);
  console.log('Contents: Kikoenai/{node/node.exe, app/ (= backend/build/), ffmpeg/{ffmpeg,ffprobe}.exe, Kikoenai.bat}');
}

main().catch((err) => { console.error(err); process.exit(1); });
