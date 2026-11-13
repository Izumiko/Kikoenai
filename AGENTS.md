# Kikoenai — Agent Guide (root)

**Kikoenai** is a self-hosted media streaming server for ASMR voice works. This is the top-level agent guide for the monorepo; it covers layout, workspace commands, and cross-package integration. For package-specific architecture, conventions, and gotchas, read the sub-guides:

- **Backend work → [`backend/AGENTS.md`](backend/AGENTS.md)** (Express API, SQLite/Knex, sessions, Socket.IO, scraping)
- **Frontend work → [`frontend/AGENTS.md`](frontend/AGENTS.md)** (Vue 3 / Quasar PWA, Vuex, Plyr, Socket.IO client)

User-facing install/deploy docs live in [`README.md`](README.md). License: GPL-3.0-or-later.

---

## 1. Layout

```
kikoenai/
├── package.json            # npm workspaces root (name: "kikoeru")
├── UPSTREAM.md             # How this fork syncs with Rivers47/Kikoenai
├── backend/                # Express API server (TypeScript, Node 26) → see backend/AGENTS.md
│   └── build/              # Self-contained deployment unit (esbuild output; gitignored)
├── frontend/               # Vue 3 / Quasar PWA → see frontend/AGENTS.md
│   └── tests/              # Playwright e2e (default baseURL :8080, chromium)
├── scripts/                # dev.sh / build.sh / package.js (Windows zip) and helpers
├── .github/workflows/test.yml            # CI: lint, typecheck, tests, bundle smoke
├── .github/workflows/build.yml           # CI: production container image
├── .github/workflows/build-debug.yml     # Manual-only: `-debug` container image
├── .github/workflows/package-windows.yml # CI: Windows portable zip (built on ubuntu)
├── Containerfile           # OCI image (ghcr.io/rivers47/kikoenai)
├── .containerignore        # Build-context excludes (buildah reads this, not .dockerignore)
└── compose-example.yaml
```

`worktree-*/` and `.pi-subagents/` are local git worktrees / agent artifacts — **not** source of truth; work under `backend/` and `frontend/` only.

---

## 2. Workspace Commands

Run from repo root. Node **>= 26.0.0** (the backend is TypeScript run natively, no build step).

| Command | Purpose |
|---------|---------|
| `npm install` | Install all workspace deps |
| `npm run dev` | Backend (`node --watch`, :8888) + frontend (Quasar, :8080) concurrently |
| `npm run dev:backend` / `dev:frontend` | One side only |
| `npm run build` | Debug frontend into `backend/dist/`, then bundle the backend into `backend/build/` |
| `npm run build:prod` | Same with a production (minified) frontend |
| `npm run start:bundle -w backend` | Run the self-contained deployment unit (`node build/app.mjs`) |
| `npm start` | Run the backend from source (`node app.ts`); serves `backend/dist/` |
| `npm run lint` | backend ESLint + frontend lint (`npm test -w frontend`: i18n guard, theme-colour and contrast guards, ESLint) |
| `npm run typecheck` | `tsc --noEmit` for the backend |
| `npm test -w backend` | ESLint + typecheck + node:test |
| `npm run test:bundle -w backend` | Build `backend/build/` and smoke-test it outside the repo |
| `npm run test:package` | Windows zip writer/reader round-trip |
| `npm run package:windows` | Build the Windows portable zip (any host OS) |
| `npm run release:patch` / `:minor` / `:major` | Full release — see §5 |

Per-package scripts still work inside each workspace (e.g. `npm run scan`, `npm test` in `backend/`).

---

## 3. Cross-Package Integration

- **Build pipeline:** Frontend builds directly into `backend/dist/` (`distDir` in `frontend/quasar.config.js`); Express serves it as static content. No separate frontend deploy. `npm run build` then bundles the backend into `backend/build/`, copying `dist/` and `static/` into it — that directory is the deployment unit the container and the Windows zip ship.
- **Dev proxy:** `quasar dev` (:8080) proxies `/api` and `/socket.io` to the backend (:8888). In production `connect-history-api-fallback` lets Vue Router own all non-`/api` routes — no hash routing.
- **Shared contracts:** The REST API and Socket.IO event names are documented identically in `backend/AGENTS.md` §6 and `frontend/AGENTS.md` §6. **When changing an endpoint or event, update both sub-guides.** Scanning runs over Socket.IO (not REST); metadata editing is admin-gated via `PUT /api/work/:id`.
- **Deploy path prefix (`config.basePath`):** the app can be served under a sub-path (`https://example.com/kikoeru/`) from a single build, so URLs are owned jointly by both packages. `backend/base-path.ts` holds the contract — `frontend/quasar.config.js` requires `PUBLIC_PATH_TOKEN` straight from it (Node 26 can `require()` the ESM `.ts`), so there is one definition, not two. Read `backend/AGENTS.md` §2.4b **and** `frontend/AGENTS.md` §2.6b before touching asset paths, the service worker, Socket.IO mounting, or anything that builds a URL.

---

## 4. Agent Dispatch

| Task | Read first |
|------|-----------|
| Express route, DB migration, scraper, config schema | `backend/AGENTS.md` |
| Vue page/component, Vuex module, boot file, PWA, player UI, i18n/tag translation | `frontend/AGENTS.md` (§2.8 for i18n) |
| Root scripts, release flow, CI, container | This file + `README.md` |
| E2E browser tests | `frontend/tests/playwright.config.js` (dev server on :8080 by default; set `KIKO_TEST_BASE_URL` to point at a production build) |
| Fanza scraping source | `backend/AGENTS.md` §6 + `backend/scraper/fanza.ts` + `backend/work-id.ts` — Fanza work ids are stored underscore-free (`d215444`) since migration `20260828000000`; `d_215444` is DMM's own form and survives only in DMM URLs, cover/image file names and folder names. DLsite ids stored RJ-padded (6/8 digit); all label ids are UUIDs |
| Serving under a sub-path, asset URLs, service-worker scope | `backend/AGENTS.md` §2.4b + `frontend/AGENTS.md` §2.6b + `backend/base-path.ts` |
| Tag rename canonicalization / tag identity | `backend/AGENTS.md` §2.3 (tag canonicalization) + `backend/scraper/tag-aliases.json` + `backend/scraper/tag-aliases.ts` |
| Upstream sync, file mapping, dependency substitutions | [`UPSTREAM.md`](UPSTREAM.md) + `backend/AGENTS.md` §1 |

Changes touching both packages (e.g. a new API endpoint used by a new Vue page): read **both** sub-guides and keep their API-contract tables in sync.

---

## 5. Repo-Wide Notes

- **Product vs. package name:** Product is **Kikoenai**; the npm workspace name is still **`kikoeru`** (inherited from upstream).
- **Backend language and deployment:** strict ESM TypeScript on Node 26, run natively (`node app.ts`) — no transpile step, no `@ts-nocheck`, no native modules. `npm run build` uses esbuild (`backend/scripts/build.ts`) to produce `backend/build/`, a self-contained directory (`app.mjs`, the forked scanner entry points, chunks, copied `dist/` and `static/`) that runs with no `node_modules`. Every `__dirname` is `appDir` from `backend/app-dir.ts`. File paths and names still mirror upstream one-for-one (`.js` → `.ts`); see [`UPSTREAM.md`](UPSTREAM.md).
- **Releasing:** one command from a clean tree on `main` — `npm run release:patch` (or `:minor` / `:major`). It bumps the root `package.json`, then npm's `version` lifecycle runs `scripts/sync-version.js` (propagating the version to `backend/`, `frontend/` and `package-lock.json`) and stages those files; npm commits and tags `vX.Y.Z`, and `postversion` pushes with `--follow-tags`. The tag push triggers `build.yml` (semver-tagged container images) and `package-windows.yml` (Windows portable zip + **published** GitHub release with generated notes). Nothing manual after the one command. The `preversion` hook (`scripts/check-release-branch.js`) aborts the whole flow unless HEAD is on `main` and not detached — a tag cut on a feature branch would otherwise publish images and a release pinned to that commit.
- **Tests:** Unit/lint tests live inside each package. `npm test -w backend` runs ESLint + `tsc` + `node --test`; it invokes `node --test` with an explicit file list in `backend/package.json`, so **a new test file must be added to that list** or it never runs. Frontend `npm test` = i18n check + theme-colour/contrast guards + ESLint. The bundle smoke test is separate: `npm run test:bundle -w backend`. Browser e2e (Playwright) lives in `frontend/tests/` and expects the dev server on :8080 by default (`KIKO_TEST_BASE_URL` overrides it, e.g. for service-worker tests against a production build).
- **Container data layout:** persistent state is four folders — `config/`, `sqlite/`, `covers/`, `images/` — plus `logs/` (one file per scan run, disposable), `transcodes/` (the Opus cache) and `lyrics/` (generated subtitles the library folder would not take) — hanging off `dataRoot` (`KIKO_DATA_DIR || appDir`, where `appDir` is `backend/` from source and `backend/build/` from the bundle). The **container image sets `KIKO_DATA_DIR=/appdata`**, so one volume holds everything. Without it `dataRoot` is the application directory, which cannot take a single volume without shadowing the app itself (`app.ts`/`app.mjs`, `node_modules/` when running from source, `dist/`) — that was the old four-mount layout. The library stays a separate bind mount at `/usr/src/kikoeru/VoiceWork`; it is user media, not app state, and does not follow `KIKO_DATA_DIR`.
- **This was a breaking change for existing container deployments** (data root moved from `/usr/src/kikoeru` to `/appdata`). The exact escape hatch is `-e KIKO_DATA_DIR=/usr/src/kikoeru`, which reproduces the previous behaviour byte-for-byte with no data movement — verified. `config.ts` prints a three-line `!!!` warning at startup when `IS_DOCKER` is set, the app directory holds a `sqlite/db.sqlite3`, and the current data root does not; it is advisory only and changes no behaviour. Mention this in release notes and bump the minor version. See `backend/AGENTS.md` §2.4 for the `rerootFromAppDir` rule that keeps a pre-existing `config.json` from silently leaving the covers and database behind.
- **`backend/dist/` now depends on the server that serves it.** The frontend build bakes a placeholder (`/__KIKO_BASE__/`) into `index.html`, `sw.js` and `manifest.json` instead of a real URL prefix, and `app.ts` swaps it for `config.basePath` on the way out. Express has always been the only thing serving `dist/`, so nothing in the documented setup changes — but a plain static file server pointed at `dist/` would now serve broken markup. `config.basePath` defaults to `''`, which reproduces the previous root-served URLs exactly.
- **Windows portable builds are unaffected** by any of this: `scripts/launchers/Kikoenai.bat` sets `KIKO_DATA_DIR=%ROOT%` itself, so its data has always lived in one folder next to the launcher. The zip is assembled by `scripts/package.js` on any host OS — pinned `node/node.exe`, `app/` (= `backend/build/`), `ffmpeg/`, and the launcher. There is no node_modules and nothing native, so the old `pkg` single-exe build is gone.
- **The `Containerfile` declares no `VOLUME`, deliberately.** It only takes effect when the operator mounts nothing at that path, and then produces *anonymous* volumes — with `KIKO_DATA_DIR` set those would be four guaranteed-unused ones. Explicit mounts are unaffected, so its removal changed nothing for any documented setup.
- **`.containerignore`, not `.dockerignore`:** the image is built by `redhat-actions/buildah-build`, which prefers that filename; there is no Docker/BuildKit in the pipeline. It keeps a developer's `backend/config/` (holds `md5secret`/`jwtsecret`), `backend/sqlite/`, `backend/covers/`, `backend/images/`, `backend/transcodes/`, `backend/lyrics/`, `backend/logs/` and `backend/VoiceWork/` out of locally built images, and keeps a host `node_modules` (built for the host libc) from overlaying the Alpine install the build stage makes itself. It also excludes `backend/dist/` and `backend/build/`: the Containerfile's build stage produces both inside the image. Nothing in the tree is native any more — sqlite3 is replaced by `node:sqlite` — so there is no native addon to compile.
- **CI:** `.github/workflows/test.yml` runs ESLint, `tsc`, `node:test`, the Windows zip round-trip test, the frontend build and the bundle smoke test on every push and PR. `build.yml` builds the production OCI image on every push; the Containerfile's build stage runs `npm ci` and builds the frontend and backend **inside** the image, so the runner needs no Node install and no pre-built artifacts. `build-debug.yml` builds the `-debug` variant (unminified bundle + source maps) and is **`workflow_dispatch` only** — run it from the Actions tab on the branch/tag you want to debug. `package-windows.yml` assembles the portable zip on **ubuntu-latest**, because nothing in the bundle is native. `build.yml` and `build-debug.yml` both set `flavor: latest=false` on `docker/metadata-action`; without it the default `latest=auto` emits an extra unsuffixed `latest` on semver tag pushes, which is how the debug image once ended up published as `latest`. Container sets `IS_DOCKER=true`, `NODE_ENV=production` and `KIKO_DATA_DIR=/appdata`.


## 6. Code Style

Always write comments in English.