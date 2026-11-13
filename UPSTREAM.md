# Upstream sync

This repository is a fork of [Rivers47/Kikoenai](https://github.com/Rivers47/Kikoenai),
which continues the original [Kikoeru](https://github.com/nortonandrews/kikoeru) monorepo.
The fork differs from upstream in one structural way: the backend is strict ESM
**TypeScript run natively by Node 26** (`node app.ts`, no transpile step, no
`@ts-nocheck`), bundled by esbuild for deployment. See
`docs/superpowers/specs/2026-11-09-typescript-migration-design.md`.

Everything else — file layout, REST/Socket.IO API, database schema,
`config.json` shape — is kept identical to upstream on purpose, so upstream work
can be ported file for file. This document is the map for doing that.

## Remote and last sync point

```
upstream  https://github.com/Rivers47/Kikoenai.git
```

**Last synced upstream commit: `f0ec290`**

Add the remote once per clone if it is missing:

```bash
git remote add upstream https://github.com/Rivers47/Kikoenai.git
git fetch upstream
```

The conversion is complete, so upstream backend changes are ported file for
file, as described below.

## File mapping

| Upstream | Here |
|----------|------|
| `backend/**/X.js` | `backend/**/X.ts` — same path, same basename |
| `backend/eslint.config.js` | rewritten for ESM + `typescript-eslint`, but still plain `.js` — ESLint would need an extra loader (jiti) to read a TS config |
| `backend/package.json` | `"type": "module"`, Node 26 engines, no native modules |
| `frontend/**` | still plain JS/Vue built by Quasar, but **not byte-identical** — see the divergence table below |
| `backend/test/**/X.js` | `backend/test/**/X.ts`; test names such as `test/migration..ts` keep upstream's odd spelling |
| `backend/database/migrations/X.js` | `backend/database/migrations/X.ts` |
| (none) | `backend/database/migrations/index.ts` — the static migration manifest |

A migration file is renamed, but the **name reported to knex keeps the original
`.js` spelling**, because `knex_migrations` rows written by the CommonJS version
hold that name. `database/migrations/index.ts` does the renaming per entry and
`database/knex-migrate.ts` feeds the list to knex as a custom migration source.

### Files outside `backend/` that differ from upstream

The branch shares history with upstream (`f0ec290` is an ancestor), so
`git merge upstream/main` and `git cherry-pick` work normally. What does **not**
work is dropping upstream files in wholesale: a few files outside `backend/`
are locally modified for the TypeScript build. This is the complete list as of
`f0ec290..HEAD`; regenerate it with:

```bash
git diff --stat f0ec290..HEAD -- . ':!backend'
```

| File | What is local |
|---|---|
| `.containerignore` | rewritten for the two-stage Containerfile (excludes `backend/dist`, `backend/build`, runtime data, `scripts`, docs) |
| `.github/workflows/build-debug.yml` | debug image built inside the Containerfile (`KIKO_DEBUG=1`), `workflow_dispatch` only |
| `.github/workflows/build.yml` | production image built inside the Containerfile on Node 26 — no host Node step |
| `.github/workflows/package-windows.yml` | Windows portable zip assembled on `ubuntu-latest` |
| `.github/dependabot.yml` | the docker ecosystem tracks the `node:26-alpine` tags in the Containerfile |
| `.github/workflows/test.yml` | **new**: lint/typecheck/`node:test`, zip round-trip, frontend build, bundle smoke test |
| `.gitignore` | ignores `/package/` (portable-zip output) |
| `AGENTS.md` | root agent guide rewritten for the TypeScript layout and build (docs only) |
| `Containerfile` | two-stage Node 26 build; the runtime stage ships only `backend/build/` |
| `README.md` | fork install/build docs: TypeScript layout, new scripts, portable zip (docs only) |
| `UPSTREAM.md` | **new**: this file |
| `docs/superpowers/plans/2026-11-09-typescript-migration.md` | **new**: migration plan (docs only) |
| `docs/superpowers/specs/2026-11-09-typescript-migration-design.md` | **new**: migration design spec (docs only) |
| `frontend/AGENTS.md` | three backend `.ts` / test-command references (docs only) |
| `frontend/package.json` | `@babel/preset-typescript` devDependency; `engines.node` `>= 26` |
| `frontend/quasar.config.js` | requires `../backend/base-path.ts`; adds the `../backend` Babel TS loader rule |
| `package-lock.json` | regenerated for the workspace/Node 26 changes — regenerate with `npm install`, never hand-merge |
| `package.json` | `build:backend` / `build:prod` / `typecheck` / `test:package` scripts; `build` = frontend + bundle; `package:windows` → `scripts/package.js`; `engines.node` `>= 26` |
| `scripts/build.sh` | builds frontend + backend bundle from the repo root |
| `scripts/check-lyrics.mjs` | imports the backend `.ts` modules with dynamic `import()` |
| `scripts/dev.sh` | starts both sides through the root workspace scripts (`node --watch`) |
| `scripts/launchers/Kikoenai.bat` | launches `app\app.mjs`; the single-exe branch is gone |
| `scripts/package.js` | rewritten portable-zip packager (stdlib only, writes the zip by hand) |
| `scripts/package.test.mjs` | **new**: round-trip test for the zip writer/reader |
| `scripts/pkg-package.js` | **deleted** (the `pkg` single-exe build) |

#### Frontend build integration — do not take upstream's copy

Two frontend files carry the integration with the backend TypeScript sources:

- `frontend/quasar.config.js` requires `../backend/base-path.ts` (upstream:
  `base-path` / `base-path.js`) and adds a `babel-loader` +
  `@babel/preset-typescript` rule scoped to `../backend`, so `quasar build` can
  import `backend/database/search-query.ts`.
- `frontend/package.json` adds the `@babel/preset-typescript` devDependency and
  raises `engines.node` to `>= 26`.

Copying upstream's version of either file deletes that integration and the
frontend build fails. So:

1. **Whole release:** `git merge upstream/main` (or `git cherry-pick`), and on a
   conflict in those files keep the local side, then port upstream's unrelated
   changes into them by hand. `frontend/AGENTS.md` is docs only — keeping local
   loses nothing there.
2. **A single upstream patch:** apply it excluding the locally modified files,
   then hand-port their hunks. Excluded paths are skipped silently, so look at
   them separately first:

   ```bash
   git diff f0ec290..upstream/main -- frontend/quasar.config.js \
                                      frontend/package.json \
                                      frontend/AGENTS.md

   git diff f0ec290..upstream/main -- frontend/ \
     | git apply -3 \
         --exclude=frontend/quasar.config.js \
         --exclude=frontend/package.json \
         --exclude=frontend/AGENTS.md
   ```

   A plain `git apply` of the whole frontend diff fails atomically at these
   files, so nothing lands at all. `git apply -3` also stages what it applies.
3. Never `git checkout upstream/main -- frontend/quasar.config.js
   frontend/package.json`: it silently removes the `base-path.ts` require, the
   TS loader rule and the Babel preset.

### Files added by this fork (not in upstream)

Outside `backend/`:

- `.github/workflows/test.yml` — CI: lint/typecheck/`node:test`, zip test,
  frontend build, bundle smoke test
- `scripts/package.test.mjs` — zip writer/reader round-trip test
- `docs/superpowers/plans/2026-11-09-typescript-migration.md` and
  `docs/superpowers/specs/2026-11-09-typescript-migration-design.md` — the
  migration plan and the design spec (authority for the backend changes)
- `UPSTREAM.md` (this file)

Inside `backend/`:

- `app-dir.ts` — the deployment directory, replacing `__dirname`
- `tsconfig.json`
- `database/node-sqlite-client.ts` — knex client over `node:sqlite`
- `database/migrations/index.ts` — the static migration manifest
- `lib/load-env.ts`, `lib/limit-promise.ts`, `lib/url-join.ts`, `lib/uuid-v5.ts`
  — local replacements for removed packages
- `types/*.ts`, `types/*.d.ts` — shared types
- `scripts/build.ts` (esbuild bundler), `scripts/freeze-config.ts`
- `test/setup-env.ts`, `test/node-sqlite-client.ts`, `test/migration-names.ts`,
  `test/lib.ts`, `test/bundle-smoke.ts`

`scripts/pkg-package.js` went the other way: it was deleted, together with the
`pkg` block in `backend/package.json`.

## Dependency substitutions

Principle: replace anything with a Node built-in equivalent; keep pure-JS
packages that have no equivalent (esbuild bundles them, so a deployment still
needs no `node_modules`). From the design spec §5.4, as built:

| Upstream dependency | Here |
|---|---|
| `sqlite3` | removed → `node:sqlite` (`database/node-sqlite-client.ts`) |
| `dotenv` | removed → `process.loadEnvFile()` (`lib/load-env.ts`) |
| `md5` | removed → `crypto.createHash('md5')` (same algorithm, old hashes stay valid) |
| `lodash` | removed → built-ins / local helpers (`structuredClone`) |
| `url-join` | removed → `lib/url-join.ts` |
| `yargs` | removed → `util.parseArgs` |
| `limit-promise` | removed → `lib/limit-promise.ts` |
| `uuid` (v5) | removed → `lib/uuid-v5.ts` (SHA-1 over `crypto`) |
| `htmlparser2`, `string-random` | removed (unused) |
| `mocha` + `chai` | removed → `node:test` + `node:assert` |
| `nodemon` | removed → `node --watch` |
| `natural-orderby` | **kept** — `Intl.Collator` does not sort identically, and it decides track order |
| `undici` | **kept** — needs an `Agent` to disable the built-in 300s timeouts |
| `tunnel-agent` | **kept** — HTTPS through an HTTP proxy needs a CONNECT tunnel |
| `express`, `compression`, `cookie`, `cookie-parser`, `connect-history-api-fallback`, `express-validator`, `socket.io`, `axios`, `cheerio`, `jschardet`, `knex`, `compare-versions`, `mime-types` | kept |
| `serve-index` | kept as a devDependency only (development static file listing) |

## Sync checklist

When porting an upstream change, walk this list:

- **New backend file:** create it at the same path/basename with `.ts`, ESM
  imports, and no `@ts-nocheck` (there are none left in the tree).
- **New relative import:** keep the `.ts` extension (`import x from './x.ts'`).
  ESM has no extensionless resolution here.
- **New `require(...)` / `module.exports`:** rewrite to `import` / `export`.
  Lazy `require` used to break cycles becomes a top-level import or `await import()`.
- **New `__dirname` / `__filename`:** use `appDir` from `backend/app-dir.ts`.
  It resolves to `backend/` from source and `backend/build/` from the bundle.
- **New migration:** add the `.ts` file **and** one entry in
  `database/migrations/index.ts`, reporting upstream's original `.js` filename.
  Also bump `dbVersion` in `database/schema.ts` to the new timestamp prefix.
- **New dependency:** first decide whether a Node 26 built-in replaces it
  (see the table above). If it is kept, it must be pure JS or bundled cleanly;
  native modules would break the "no node_modules deployment" rule.
- **New runtime data file read from disk** (JSON, templates, …): either import
  it (`import data from './x.json' with { type: 'json' }`) so esbuild inlines
  it, or add it to the copy step in `backend/scripts/build.ts` (today that is
  `dist/` and `static/`).
- **New test file:** add it to the explicit file list in the `test` script in
  `backend/package.json`. `node --test` is invoked with named files, so a test
  that is not listed never runs.
- **New CLI script** that a deployment must have (container image / Windows
  zip ship only `backend/build/`): add it to `ENTRY_POINTS` in
  `backend/scripts/build.ts`.
- **New frontend file:** apply it as upstream wrote it — the frontend stays
  plain JS. Only the three files in the divergence table keep a local side.
- **After porting:** run `npm test -w backend`, `npm run build` and
  `npm run test:bundle -w backend`, then update *Last synced upstream commit*
  at the top of this file.

## Example sync flow

```bash
git fetch upstream

# What arrived since the last sync (f0ec290 is the value at the top of this file)
git log --oneline f0ec290..upstream/main

# Backend work: review the diff, then port it by hand into the matching .ts file
git log --oneline f0ec290..upstream/main -- backend/
git diff f0ec290..upstream/main -- backend/database/queries.js

# Frontend work is plain JS, but three files are locally modified (see the
# divergence table). A plain `git apply` of the whole frontend diff fails
# atomically there, so look at those hunks separately, then apply the rest:
git diff f0ec290..upstream/main -- frontend/quasar.config.js \
                                   frontend/package.json \
                                   frontend/AGENTS.md
git diff f0ec290..upstream/main -- frontend/ \
  | git apply -3 \
      --exclude=frontend/quasar.config.js \
      --exclude=frontend/package.json \
      --exclude=frontend/AGENTS.md

# Whole-release alternative: merge/cherry-pick, keep the local side in those
# files, then re-apply upstream's unrelated edits to them by hand.
git merge upstream/main
# or:
git cherry-pick <sha>
```

For a whole upstream release, `git merge upstream/main` is fine as a starting
point; resolve conflicts in favour of the `.ts` files here and re-apply the
mapping rules above. Then verify:

```bash
npm install
npm test -w backend          # ESLint + tsc + node:test
npm run build                # frontend into backend/dist, backend into backend/build
npm run test:bundle -w backend
```

Finish by changing the sync commit at the top of this file to the
`upstream/main` SHA that was ported, and commit everything together.
