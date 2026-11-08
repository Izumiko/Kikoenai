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

**Last synced upstream commit: `0d3faa0`**

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
| `frontend/**` | unchanged (plain JS/Vue, still built by Quasar) |
| `backend/test/**/X.js` | `backend/test/**/X.ts`; test names such as `test/migration..ts` keep upstream's odd spelling |
| `backend/database/migrations/X.js` | `backend/database/migrations/X.ts` |
| (none) | `backend/database/migrations/index.ts` — the static migration manifest |

A migration file is renamed, but the **name reported to knex keeps the original
`.js` spelling**, because `knex_migrations` rows written by the CommonJS version
hold that name. `database/migrations/index.ts` does the renaming per entry and
`database/knex-migrate.ts` feeds the list to knex as a custom migration source.

Files that exist here but not upstream:

- `backend/app-dir.ts` — the deployment directory, replacing `__dirname`
- `backend/tsconfig.json`
- `backend/database/node-sqlite-client.ts` — knex client over `node:sqlite`
- `backend/database/migrations/index.ts`
- `backend/lib/load-env.ts`, `lib/limit-promise.ts`, `lib/url-join.ts`, `lib/uuid-v5.ts`
  — local replacements for removed packages
- `backend/types/*.ts`, `backend/types/*.d.ts` — shared types
- `backend/scripts/build.ts` (esbuild bundler), `backend/scripts/freeze-config.ts`
- `backend/test/setup-env.ts`, `test/node-sqlite-client.ts`, `test/migration-names.ts`,
  `test/lib.ts`, `test/bundle-smoke.ts`
- `UPSTREAM.md` (this file)

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
- **New frontend file:** no action — the frontend stays plain JS.
- **After porting:** run `npm test -w backend`, `npm run build` and
  `npm run test:bundle -w backend`, then update *Last synced upstream commit*
  below.

## Example sync flow

```bash
git fetch upstream

# What arrived since the last sync (0d3faa0 is the value at the top of this file)
git log --oneline 0d3faa0..upstream/main

# Backend work: review the diff, then port it by hand into the matching .ts file
git log --oneline 0d3faa0..upstream/main -- backend/
git diff 0d3faa0..upstream/main -- backend/database/queries.js

# Frontend work touches no TypeScript: apply it directly
git diff 0d3faa0..upstream/main -- frontend/ | git apply
# or per commit:
git cherry-pick <frontend-only-sha>
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
