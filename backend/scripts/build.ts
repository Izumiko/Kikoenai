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
//
// The scanner trio is forked (socket.ts) and the CLI scripts are the documented
// one-shot maintenance commands (`npm run backfill:progress`, `npm run
// import:legacy-history`). They belong in the bundle because build/ ships
// WITHOUT node_modules and without the .ts sources, so these are the only way
// those commands exist in a container or the Windows zip.
const ENTRY_POINTS = [
  'app.ts',
  'filesystem/scanner.ts',
  'filesystem/updater.ts',
  'filesystem/workFileScanner.ts',
  'scripts/backfill-progress.ts',
  'scripts/import-legacy-history.ts',
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
  // The build result's `outputs` are what stale cleanup compares against, so a
  // chunk that kept its hash is never deleted as if it were a leftover.
  metafile: true,
  logLevel: 'info',
};

/**
 * Replace `to` with a copy of `from`, or report that the source is missing.
 * Skipping instead of failing keeps a backend-only build possible; the warning
 * is what tells the operator the deployment has no WebApp (or no placeholder
 * image). The previous copy is removed before the check: when the source is
 * absent, keeping the stale copy would make the deployment serve a build this
 * one did not produce.
 */
const copyIntoBuild = (from: string, to: string, label: string): void => {
  fs.rmSync(to, { recursive: true, force: true });
  if (!fs.existsSync(from)) {
    console.warn(` ! ${label} not found at ${from} -- skipping it.`);
    return;
  }
  fs.cpSync(from, to, { recursive: true });
};

/** A file this script owns: an entry point, a shared chunk, or a source map. */
const isBundleArtifact = (name: string): boolean => name.endsWith('.mjs') || name.endsWith('.map');

/**
 * Artifacts an earlier build left in outDir.
 *
 * Collected BEFORE the build and removed only AFTER it succeeds: a failed build
 * must not delete the chunks the existing app.mjs still imports. Directories
 * are skipped on purpose -- `dist/` and `static/` are copies, the deployment
 * may hold data (config/, sqlite/, ...) when KIKO_DATA_DIR is unset, and
 * fs.rmSync without `recursive` throws on a directory.
 */
const collectPreviousArtifacts = (): string[] => {
  if (!fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isBundleArtifact(entry.name))
    .map((entry) => entry.name);
};

/**
 * Remove the artifacts this build did not emit: chunks whose hash changed,
 * source maps a later minified build does not write, and entry points that are
 * no longer in ENTRY_POINTS (their `<name>.mjs` would otherwise linger in the
 * deployment forever).
 */
const removeStaleArtifacts = (previous: string[], emitted: ReadonlySet<string>): void => {
  for (const name of previous) {
    if (emitted.has(name)) continue;
    fs.rmSync(path.join(outDir, name), { force: true });
  }
};

const main = async (): Promise<void> => {
  const previousArtifacts = collectPreviousArtifacts();
  const result = await build(options);
  const emitted = new Set(Object.keys(result.metafile?.outputs ?? {}).map((output) => path.basename(output)));
  removeStaleArtifacts(previousArtifacts, emitted);
  // The frontend builds into backend/dist (frontend/quasar.config.js), so there
  // is nothing to rebuild here -- only to carry into the deployment directory.
  copyIntoBuild(path.join(appDir, 'dist'), path.join(outDir, 'dist'), 'Frontend build (dist/)');
  copyIntoBuild(path.join(appDir, 'static'), path.join(outDir, 'static'), 'Static assets (static/)');

  const bundles = ENTRY_POINTS
    .map((entry) => `${path.basename(entry, '.ts')}.mjs`)
    .filter((name) => fs.existsSync(path.join(outDir, name)))
    .sort();
  console.log(`Bundled ${ENTRY_POINTS.length} entry points${debug ? ' (debug: unminified, with source maps)' : ''}.`);
  console.log(`Output: ${outDir}`);
  console.log(`  ${bundles.join('\n  ')}`);
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
