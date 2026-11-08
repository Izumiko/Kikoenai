// Bundle the backend into a self-contained `build/` directory.
//
//   node scripts/build.ts           # minified
//   node scripts/build.ts --debug   # unminified, with source maps
//
// The output is the deployment unit: app.mjs, the three forked scanner entry
// points, their shared chunks (flat, all in build/), plus a copy of the frontend
// build (dist/) and static/. Nothing outside this directory is needed at
// runtime except Node itself and the ffmpeg/ffprobe binaries.
//
// app-dir.ts is what makes the bundle relocatable: every __dirname-style path
// in the source is resolved against it, and inlined into build/ it resolves to
// this directory (see app-dir.ts).

import fs from 'fs';
import path from 'path';
// eslint-disable-next-line n/no-unpublished-import
import { build, type BuildOptions } from 'esbuild';
import { appDir } from '../app-dir.ts';

const outDir = path.join(appDir, 'build');

// Destination basenames come from the source basenames: filesystem/scanner.ts
// becomes build/scanner.mjs, so socket.ts can fork `<appDir>/scanner.mjs`.
const ENTRY_POINTS = [
  'app.ts',
  'filesystem/scanner.ts',
  'filesystem/updater.ts',
  'filesystem/workFileScanner.ts',
];

// knex requires() a dialect driver only for dialects this app never selects:
// its client is database/node-sqlite-client.ts, which extends the better-sqlite3
// dialect but overrides _driver() with the built-in node:sqlite, so the driver
// package is never loaded. serve-index is a devDependency imported only when
// NODE_ENV=development (see app.ts). Keeping them external means esbuild never
// tries to resolve them -- which would fail, as they are not installed in a
// deployment -- while the `require()` calls that mention them stay dead code.
const EXTERNAL = [
  'sqlite3',
  'better-sqlite3',
  'mysql',
  'mysql2',
  'pg',
  'pg-native',
  'pg-query-stream',
  'oracledb',
  'tedious',
  'mariadb/callback',
  'serve-index',
];

// ESM has no `require`, but the bundled CommonJS dependencies are full of it
// (and keep it for the externals above). Every output file gets one built from
// its own URL, which is exactly what the CJS module would have had.
const REQUIRE_BANNER = "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);";

const debug = process.argv.includes('--debug');

const options: BuildOptions = {
  entryPoints: ENTRY_POINTS.map((entry) => path.join(appDir, entry)),
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  // One chunk per shared module graph instead of a copy per entry point; the
  // flat naming below keeps entries and chunks in the same directory, which is
  // what makes `appDir` the deployment directory for all of them.
  splitting: true,
  outExtension: { '.js': '.mjs' },
  entryNames: '[name]',
  chunkNames: 'chunk-[hash]',
  external: EXTERNAL,
  banner: { js: REQUIRE_BANNER },
  minify: !debug,
  sourcemap: debug,
  logLevel: 'info',
};

/**
 * Replace `to` with a copy of `from`, or report that the source is missing.
 * Skipping instead of failing keeps a backend-only build possible; the warning
 * is what tells the operator the deployment has no WebApp (or no placeholder
 * image).
 */
const copyIntoBuild = (from: string, to: string, label: string): void => {
  if (!fs.existsSync(from)) {
    console.warn(` ! ${label} not found at ${from} -- skipping it.`);
    return;
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
};

/**
 * Drop artifacts left by an earlier build: chunks (their names carry a content
 * hash, so a rebuild produces new ones) and source maps (a --debug build leaves
 * them behind for a later minified build). Nothing else is touched: with
 * KIKO_DATA_DIR unset, a running deployment's data (config/, sqlite/, covers/,
 * ...) lives in this directory too and must survive a rebuild.
 */
const removeStaleArtifacts = (): void => {
  if (!fs.existsSync(outDir)) return;
  for (const file of fs.readdirSync(outDir)) {
    if (file.startsWith('chunk-') || file.endsWith('.map')) {
      fs.rmSync(path.join(outDir, file), { force: true });
    }
  }
};

const main = async (): Promise<void> => {
  removeStaleArtifacts();
  await build(options);
  // The frontend builds into backend/dist (frontend/quasar.config.js), so there
  // is nothing to rebuild here -- only to carry into the deployment directory.
  copyIntoBuild(path.join(appDir, 'dist'), path.join(outDir, 'dist'), 'Frontend build (dist/)');
  copyIntoBuild(path.join(appDir, 'static'), path.join(outDir, 'static'), 'Static assets (static/)');

  const bundles = fs.readdirSync(outDir).filter((file) => file.endsWith('.mjs')).sort();
  console.log(`Bundled ${ENTRY_POINTS.length} entry points${debug ? ' (debug: unminified, with source maps)' : ''}.`);
  console.log(`Output: ${outDir}`);
  console.log(`  ${bundles.join('\n  ')}`);
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
