# Kikoenai Backend — AGENTS Guide

**Kikoenai** is a self-hosted media streaming server for [DLsite](https://www.dlsite.com) voice works (doujin audio). This is the Express API server; the Quasar-based frontend SPA/PWA lives in sibling package `frontend/`.

- **Language:** TypeScript (strict, ESM), run natively by **Node 26** (**Express 5**)
- **Database:** SQLite via Knex.js, using the built-in `node:sqlite` (no `sqlite3` addon)
- **Auth:** Server-side sessions in an HttpOnly cookie
- **Real-time:** Socket.IO
- **Scraping:** Axios + Cheerio
- **License:** GPL-3.0-or-later

---

## 1. Project Structure

```
├── routes/                  # Express route handlers (mounted under /api)
│   ├── index.ts             # Route aggregator
│   ├── auth.ts              # Login, user info, password change
│   ├── config.ts            # Read/write server config
│   ├── credentials.ts       # User CRUD (admin only)
│   ├── media.ts             # Audio streaming, download, lyric sidecar lookup
│   ├── metadata.ts          # Works listing, search, sort, filter, tag/VA queries
│   ├── play_history.ts      # Playback state persistence
│   ├── review.ts            # Reviews, ratings, progress
│   ├── track_progress.ts    # Per-track playback position
│   ├── version.ts           # Version info, release notes
│   └── utils/               # Shared route utilities (normalize, strftime, url, validate)
├── auth/
│   ├── session.ts           # Session create/lookup/destroy, cookie options
│   └── utils.ts             # Salted md5 password hashing
├── config/
│   └── config.json          # Runtime config (auto-generated on first run)
├── covers/                  # Cached cover images
├── images/                  # Scraped sample + description images (config.imageFolderDir)
├── database/
│   ├── search-query.ts      # Advanced search syntax parser (E-Hentai style `field:"value"`)
│   ├── db.ts                # Thin re-export: singleton knex + databaseExist + queries (via makeQueries)
│   ├── queries.ts           # makeQueries(knex) factory: all query functions bound to a knex instance
│   ├── init.ts              # App initialization (db creation, migration, config upgrade)
│   ├── knexfile.ts          # Knex config for migrations
│   ├── knex-migrate.ts      # Migration runner (knex's own engine, fed by the manifest)
│   ├── node-sqlite-client.ts # Knex client over node:sqlite (replaces the sqlite3 addon)
│   ├── migrations/          # DB migration files (timestamped, 34 migrations)
│   ├── migrations/index.ts  # Static migration manifest; reports the original .js names
│   └── schema.ts            # Full database schema (createSchema with all tables)
├── dist/                    # Frontend build output (kikoeru-quasar)
├── filesystem/
│   ├── scanner.ts           # Entry point: child process for scanning
│   ├── scannerModules.ts    # Core scanning logic (~25KB)
│   ├── updater.ts           # Metadata update entry point
│   ├── workFileScanner.ts   # Lyric file scanner entry point
│   ├── workExtras.ts        # Sample/description image download + DLsite review scraping (shared: scanner + refresh route)
│   ├── workFiles.ts         # t_work_file index and the one file-listing read path
│   ├── scanLog.ts           # Per-run scan log file (dataRoot/logs)
│   └── utils.ts             # File system utilities
├── lib/                     # Local replacements for removed packages
│   ├── load-env.ts          # process.loadEnvFile() side effect (replaces dotenv)
│   ├── limit-promise.ts     # Small concurrency limiter (replaces limit-promise)
│   ├── url-join.ts          # URL joining (replaces url-join)
│   └── uuid-v5.ts           # Name-based UUID v5 over crypto (replaces uuid)
├── scraper/
│   ├── dlsite.ts            # DLsite metadata scraper (primary)
│   ├── asmrOne.ts           # ASMR.one scraper
│   ├── hvdb.ts              # HVDB scraper
│   ├── fanza.ts             # Fanza (DMM) scraper
│   ├── axios.ts             # Axios instance with proxy support
│   ├── tag-aliases.ts       # Loads tag-aliases.json (rename canonicalization)
│   ├── va-aliases.ts        # Loads va-aliases.json
│   └── utils.ts             # Scraper utilities
├── scripts/                 # Maintenance CLIs and the bundler
│   ├── build.ts             # esbuild -> build/ (the deployment unit)
│   ├── freeze-config.ts     # Never write config.json when imported
│   ├── backfill-progress.ts # One-shot CLI (also bundled)
│   ├── import-legacy-history.ts # One-shot CLI (also bundled)
│   └── …                    # rekey/track-title/tag-map tools (source only)
├── sqlite/
│   └── db.sqlite3           # SQLite database file
├── static/                  # Static assets
├── test/                    # node:test suite and fixtures (see §9)
├── types/                   # Shared types and third-party .d.ts additions
├── build/                   # esbuild output: app.mjs, chunks, dist/, static/ (auto-generated)
├── app-dir.ts               # appDir: backend/ from source, build/ from the bundle
├── asr.ts                   # ASR server client: env config, upload, Content-Type -> extension
├── transcribe-work.ts       # Transcribe one work: skip/write/fallback/re-index (TRANSCRIBE_WORK)
├── suggest-track-titles.ts  # SUGGEST_TRACK_TITLES socket handler (orchestration)
├── track-titles.ts          # Track-title extraction pipeline (no DB access)
├── work-id.ts               # Work-id helpers: isFanzaId / isBooksId / canonicalizeWorkId / fanzaCid / workno
├── api.ts                   # API setup: session middleware + route mounting
├── app.ts                   # Entry point: Express app, HTTP/HTTPS, Socket.IO
├── base-path.ts             # Deploy path prefix (PUBLIC_PATH_TOKEN, normalizeBasePath)
├── config.ts                # Config file read/write, defaults, migration
├── socket.ts                # Socket.IO initialization + scanner IPC
├── common.ts                # Shared utilities
├── upgrade.ts               # Upgrade-specific logic
├── eslint.config.js         # ESLint flat config (plain JS on purpose)
├── tsconfig.json            # strict, erasable-only, noEmit
└── VoiceWork/               # Default audio library directory (symlink or mount)
```

Every file keeps upstream's path and basename; the only extension change is
`.js` → `.ts`. Files added for the migration (`app-dir.ts`, `lib/`,
`types/`, `scripts/build.ts`, the migration manifest) are listed in
[`../UPSTREAM.md`](../UPSTREAM.md).


---

## 2. Architecture & Key Design Decisions

### 2.1 App Lifecycle (`app.ts`)

1. **Environment:** `lib/load-env.ts` is the first import of `app.ts` — a side-effect module that calls `process.loadEnvFile()` (a missing `.env` is ignored), replacing `dotenv`. `unhandledRejection` crashes in test/production mode.
2. **Database init:** `initApp()` runs asynchronously (non-blocking) — creates/migrates the DB and upgrades config.
3. **Middleware stack (in order):**
   - `trust proxy` (if behind reverse proxy)
   - `compression` (gzip, if enabled)
   - `express.json` + `express.urlencoded` (built-in body parsing, Express 5)
   - Host-header check, then the Local-Network-Access preflight answer
   - **`site` router**, mounted at `config.basePath || '/'` — everything below
     this line lives on it, not on `app`:
     - Dev-only: static file serving for `VoiceWork/`
     - `connect-history-api-fallback` (SPA routing, except `/api/*`)
     - API routes (via `api.ts`)
     - `servePrefixedAssets` (index.html / sw.js / manifest.json)
     - Static files from `dist/`
   - Error handler (401 for `UnauthorizedError`, 500 for others)

   The two middlewares above the router stay on `app` on purpose: they are
   about the connection (which Host, which Origin), not about where in the URL
   space the app lives, so they must run for a request aimed anywhere.
4. **Dual HTTP/HTTPS** server creation.
5. **Socket.IO** attached to both servers.

### 2.2 Authentication (`auth/session.ts`)

Two modes:
- **Auth enabled** (`config.auth: true`): a session is required. The `authenticate` middleware in `api.ts` validates it on all `/api/*` routes except `POST /auth/me` (login) and `GET /health`. Socket.IO reads the same cookie off the handshake headers.
- **Auth disabled** (`config.auth: false`): No authentication. All requests proceed as admin.

Session details:

- The client holds a 32-byte random secret; `t_session.id` stores only its SHA-256, so a leaked database file does not yield live sessions.
- Read from the `kikoeru_sid` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` only when `config.httpsEnabled`), falling back to `Authorization: Bearer <secret>` for non-browser clients. `POST /api/auth/me` returns the secret as `session` in the body for exactly that case; the web app ignores it and relies on the cookie.
- **There is no `?token=` query parameter.** It was removed with the JWT migration — a credential in a URL leaks into access logs, browser history, and Cache Storage keys.
- `group` is read live from `t_user` on every request, so demoting an administrator takes effect immediately.
- Revocation: `DELETE /api/credentials/users` relies on the `ON DELETE CASCADE` FK; `PUT /api/credentials/users` (password change) calls `destroyUserSessions`. Expired rows are swept hourly from `app.ts`.

**CSRF:** `SameSite=Lax` is the only defense, and it is sufficient *only* because every state-changing route is POST/PUT/DELETE. Adding a GET with side effects would reintroduce CSRF.

### 2.3 Database Schema

SQLite3 via Knex.js with the following tables:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `t_work` | Voice works (audio albums) | `id` (TEXT — see id note below), `title`, `dir`, `circle_id`, `nsfw`, `release`, `dl_count`, `price`, `rate_average_2dp`, `description` (**markup** as scraped; plain text on older rows and from the JSON fallback), `description_parts` (JSON), `sample_images` (JSON) |
| `t_circle` | Circles (artist groups) | `id` (UUID), `name` |
| `t_tag` | Tags | `id` (UUID), `name` |
| `t_va` | Voice actors | `id` (UUID v5), `name` |
| `t_illustrator` | Illustrators | `id` (UUID), `name` |
| `t_script_writer` | Script writers | `id` (UUID), `name` |
| `t_author` | Authors (作者) | `id` (UUID), `name` |
| `t_series` | Series (manual collections) | `id` (UUID), `name` |
| `r_tag_work` | Tag-work many-to-many | `tag_id`, `work_id` |
| `r_va_work` | VA-work many-to-many | `va_id`, `work_id` |
| `r_illustrator_work` | Illustrator-work many-to-many | `illustrator_id`, `work_id` |
| `r_script_writer_work` | Script-writer-work many-to-many | `script_writer_id`, `work_id` |
| `r_author_work` | Author-work many-to-many | `author_id`, `work_id` |
| `r_series_work` | Series-work many-to-many | `series_id`, `work_id` |
| `t_user` | Users | `name` (PK), `password`, `group` |
| `t_review` | Reviews & progress | `user_name`, `work_id`, `rating`, `review_text`, `progress` |
| `t_play_history` | Playback state | `user_name`, `work_id`, `state` (JSON) |
| `t_work_file` | A work's file listing, so a request never walks the filesystem (§2.9-0) | `work_id`, `rel_path` (PK), `duration`, `mtime`, `track_title` |
| `t_dlsite_review` | Scraped DLsite user reviews | `id` (DLsite `member_review_id`), `work_id`, `rate`, `review_title`, `review_text`, `genres` (JSON) |

**Work id / label id note (since migration `20260802000000`):** `t_work.id` and all `work_id` foreign keys are **TEXT**. A DLsite doujin work id is stored already RJ-padded (`'123456'` 6-digit, or `'01134567'` 8-digit — matching `formatID`), so the work URL `/work/123456` shows the original RJ id directly; a DLsite **books** work id keeps its prefix, `'BJ635795'`; a Fanza (DMM doujin) work id is the content-id **without its underscore**, `'d215444'` (migration `20260828000000`; DMM writes it `d_215444`). The prefix distinguishes the source — there is no separate source column. **`RJ` is stripped because it is implicit; `BJ` is not, and dropping it would collide `BJ635795` with `RJ635795`.** `work-id.ts` owns the helpers: `isFanzaId`, `isBooksId`, `canonicalizeWorkId` (`d_215444` → `d215444`, `bj…` → `BJ…`), `fanzaCid` (back to DMM's form), and `workno` (the prefixed spelling each store uses in URLs and asset file names — the single source for `RJ…`/`BJ…`/`d_…`). **All** label ids (circle/tag/va/illustrator/script_writer/series/author) are name-based UUIDs (TEXT PK) resolved by `resolveLabel` in `queries.ts`; DLsite RG/genre/SRI ids scraped from the storefront are no longer used as DB ids, and a label shared across DLsite + Fanza merges into one row.

**Tag canonicalization (rename protection):** tag names are canonicalized via `scraper/tag-aliases.json` before UUID resolution. `resolveTagLabel` in `queries.ts` (the single choke point covering scan-insert, scan-update, and admin-edit) maps a scraped new Japanese tag name back to its canonical old name so a DLsite rename folds onto the existing `t_tag` row instead of splitting into two. The map is hand-maintained (`scraper/tag-aliases.json`, loaded once at import time — restart to apply); tags not in the map pass through unchanged. Rows that already exist in a deployed DB are folded by migration `20260825000000_merge_tag_aliases.ts`, which reads the same JSON — **adding a new alias entry after that migration has run needs a fresh migration** (or a re-scan of the affected works) to merge the existing rows. Other label tables (circle/illustrator/script_writer/series) are not canonicalized. The backend always serves canonical Japanese tag names; UI/tag translation is client-side (see `frontend/AGENTS.md` i18n).

**VA canonicalization (duplicate registration):** same mechanism for voice actors, via `scraper/va-aliases.json` and `resolveVaLabel` in `queries.ts`. A VA who registered under several spellings (e.g. 乙倉ゅい / 乙倉ゅい（乙倉由依）/ 乙倉ゅい(乙倉由依) / 乙倉ゆい) otherwise gets one `t_va` row per spelling with their works split between them; the map redirects every variant to the canonical name on write. Rows that already exist in a deployed DB are folded by migration `20260814000000_merge_va_aliases.ts`, which reads the same JSON — **adding a new alias entry after that migration has run needs a fresh migration** (or a re-scan of the affected works) to merge the existing rows.

### 2.3b Search Syntax (`database/search-query.ts`)

`GET /api/search?filter=` accepts an E-Hentai style filter language — the app's **only** filter mechanism, since every label link builds one. `parseSearchQuery()` splits the raw box into terms; `applySearchTerm()` in `queries.ts` turns each into one parenthesised clause on the `t_work` query, and **every term must match (AND)**.

```
term      := ['-'] [ namespace ':' ] value
value     := '"' anything '"' | bare       # bare: '_' stands for a space
```

- **Namespaces:** `circle` (`group`), `tag` (`tags`), `va` (`cv`, `voice`), `illustrator` (`illust`), `script_writer` (`scriptwriter`, `scenario`, `script`), `series`, `author`, `title`, `id`. Case-insensitive. An **unknown** namespace is not special — `foo:bar` is searched as the literal text `foo:bar`, so titles with colons still work.
- **`$` anchors** the value (whole name, not substring), inside or right after the quotes: `va:"春日 部長$"`.
- **`-` negates** the whole term: `-tag:NTR`.
- **No namespace** = the old behaviour, matched across title + circle + tag + va + illustrator + script writer + series + author at once; a token that looks like a work code (`RJ123456`, `BJ123456`, `123456`, `d215444`, `d_215444`) resolves to that id instead.
- **Fanza ids take both spellings.** `d215444` is the stored id; `d_215444` (DMM's own form, and what a pre-migration bookmark holds) is accepted and folded onto it. The underscore-free form is only recognised as a *whole* term (`/^d_?(\d+)$/`), or a title token like `CD100001` would be read as a work code; the underscore form still matches as a substring (`d_215444.zip`) the way it always did. Detection runs on `term.raw` — the token *before* `_` becomes a space — or `d_215444` would arrive as `d 215444`.
- Matching is `LIKE`, i.e. ASCII-case-insensitive; an anchored term is `LIKE <value>` (no wildcards) rather than `=` so the two stay consistent.
- Multi-word plain input now ANDs per token (`夏 思い出`); quote it for the old whole-phrase match (`"夏の思い出"`).

**Latent bug fixed by the rewrite:** the free-text branch used to emit `title LIKE ? OR circle IN ? OR id IN ?` flat, and `nsfwFilter` appended `AND nsfw = ?` afterwards — SQLite binds `AND` tighter, so the nsfw filter only applied to the last `OR` arm. Every term is now wrapped in its own group.

### 2.4 Configuration (`config.ts`)

- Config file: `config/config.json` (auto-created with defaults on first run)
- Runtime config is exported as a shared mutable object (`config`).
- `setConfig()` merges new values but **protects** these fields: `production`, `md5secret`, `jwtsecret` (cannot be changed at runtime).
- `updateConfig()` adds missing keys with defaults on version upgrades.
- `publicConfig` class exposes a subset to the frontend (e.g., `rewindSeekTime`, `forwardSeekTime`).
- `lyricFolderDir` (default `lyrics/`) holds generated subtitles that could not be written next to the audio — see §2.9d. Same resolution rules as the folders below; empty on a writable library.
- `imageFolderDir` (default `images/`) holds scraped sample/description images, separate from `coverFolderDir`. It gets the same treatment as the cover path: relative values resolve against `dataRoot`, and `imageUseDefaultPath: true` forces `dataRoot/images`. Deployments that mount `covers/` as a volume should mount `images/` too.

**Data root and the four data folders.** All persistent state lives in `config/`, `sqlite/`, `covers/`, `images/`, each hanging off `dataRoot`. `dataRoot` is `path.resolve(KIKO_DATA_DIR || appDir)`, where `appDir` (`app-dir.ts`) is `backend/` when running the sources and `backend/build/` from the bundle. The **container image sets `KIKO_DATA_DIR=/appdata`** so one volume covers everything; the fallback (the application directory) cannot take a single volume without shadowing the app itself (`app.ts`/`app.mjs`, `node_modules/` when running from source, `dist/`). `scripts/launchers/Kikoenai.bat` sets it to the archive root for the Windows portable build. `-e KIKO_DATA_DIR=/usr/src/kikoeru` restores the pre-`/appdata` container layout exactly. See `Containerfile` and `README.md`.

- **`path.resolve` on the data root is load-bearing.** A relative `KIKO_DATA_DIR` leaves every derived path relative, which `res.sendFile` rejects and which `resolveDataFolder` re-joins onto `dataRoot` on every startup, nesting without bound. The base for a relative value is `process.cwd()` — `backend/` under `npm run dev` — and a notice is logged.
- The three configurable folders resolve through **`resolveDataFolder(dir, defaultName, useDefault)`** in `config.ts`: `useDefault` wins, then a relative path (joined to `dataRoot`), then an absolute path.
- **A data root *inside* the application directory** — `KIKO_DATA_DIR=backend/data`, or a test root under `backend/` — makes every *correct* path satisfy the appDir test below, so it gets re-rooted to `<appDir>/data/data/covers` and nests one level deeper per startup, since `setConfig` persists each round. `rerootFromAppDir` therefore returns early when `dir` is already within `dataRoot`; that ordering is the fix. A `config.json` already holding a nested path is not self-healing — delete it. Covered by `test/data-root.ts`.
- **`rerootFromAppDir` is the non-obvious part.** The admin panel saves folder paths as *absolute*, so a `config.json` written before `KIKO_DATA_DIR` was set holds e.g. `/usr/src/kikoeru/covers`. Without re-rooting, setting `KIKO_DATA_DIR` moves only the folders `config.json` does not mention (in practice just the newest key) and silently leaves the covers and database behind — a half-migrated state with no error. So an absolute path *inside the app directory* is re-rooted onto `dataRoot` and logged; a path outside it is a deliberate user choice (big disk, network share) and is left alone.
- **Never applied to `rootFolders` or `voiceWorkDefaultPath`.** Those are the user's media mounts, not app state; rewriting them would break a working library. The container keeps `VoiceWork` at `/usr/src/kikoeru/VoiceWork` regardless of `KIKO_DATA_DIR`.
- **The `Containerfile` declares no `VOLUME`, deliberately.** `VOLUME` only does anything when the operator mounts nothing at that path, and then it creates *anonymous* volumes — unnamed, easy to orphan, silently removed by `podman rm -v`, and impossible to undo in a derived image. Explicit mounts are unaffected either way.
- **Legacy-layout startup warning.** When `IS_DOCKER` is set, `dataRoot !== appDir`, the app directory holds a `sqlite/db.sqlite3` and the current data root does not, `config.ts` prints a three-line `!!!` warning naming both paths and both remedies. It is **advisory only** — it changes no behaviour. It exists because the alternative failure mode is silent: an empty data root looks like a fresh install, and a rescan then rebuilds the library without ratings, reviews, progress or play history, none of which scanning can recover.
- **Removed:** the legacy `tagLanguage` config key (was non-functional — scrapers always fetch Japanese). It is no longer in `defaultConfig`; a stale `tagLanguage` left in a pre-existing `config.json` is harmless and ignored. UI language is now per-user in the browser (see `frontend/AGENTS.md` i18n).

### 2.4b Sub-path Deployment (`base-path.ts`, `config.basePath`)

`config.basePath` (default `''`) serves the whole app — WebApp, `/api` and
`/socket.io` — under a prefix such as `/kikoeru`, so one hostname can carry
several self-hosted services. `normalizeBasePath` in `base-path.ts` reduces
whatever is in `config.json` to `''` or `/one/or/more/segments`, and every
consumer just concatenates it. **A bad value falls back to `''` with a warning
rather than throwing** — an optional setting must not stop the server booting.
Normalization runs in `resolveBasePath()`, called next to `resolveDataFolders()`
after any assignment into `config`, so the tidied value is also what gets
written back.

**The frontend is built once and works at any prefix.** That takes two halves,
and the split is the thing to understand before touching either side:

| URL kind | Carries the prefix how |
|----------|------------------------|
| Baked in at build time — `<script>`/`<link>` hrefs, the service worker precache manifest, the web app manifest | `frontend/quasar.config.js` sets `build.publicPath` to `PUBLIC_PATH_TOKEN` (`/__KIKO_BASE__/`), which `applyBasePath` swaps for the real prefix as the file is served |
| Built at runtime — API calls, router base, Socket.IO path, SW registration | Read from `window.__KIKO_BASE__`, injected into `index.html` by the same pass (`frontend/src/base-path.js`) |

Consequences worth knowing:

- **Only three files are rewritten**: `index.html`, `sw.js`, `manifest.json`
  (`PREFIXED_ASSETS` in `app.ts`). Everything else in `dist/` goes through
  `express.static` untouched. The token also survives inside `js/app.*.js`
  (webpack's baked chunk-loader path) — that copy is *not* rewritten and is
  overridden at runtime by `frontend/src/boot/base-path.js` instead.
- **`backend/dist/` is no longer servable by a plain static file server.** It
  has always been served by this Express app (`distDir` points here), but a
  build now genuinely depends on the rewrite pass.
- `quasar dev` keeps `publicPath: '/'` and injects no global, so dev is
  byte-for-byte what it was and always serves from the root.
- The rewritten assets are cached in memory, but **only when `config.production`
  is set**, so a rebuilt `dist/` shows up without restarting in development.
- **Socket.IO is not on the router.** It attaches to the raw HTTP server, so
  `socket.ts` sets `path: \`${config.basePath}/socket.io\`` itself, and
  `frontend/src/boot/socket.io.js` mirrors it. Change one, change the other.
- **The session cookie's `path` follows `basePath`**, so an install under a
  prefix does not hand its cookie to the other services on the hostname. It is
  **pinned at import time** (`COOKIE_PATH` in `auth/session.ts`), not read
  live: the setting is editable from the admin panel but the router only moves
  on restart, and a cookie scoped ahead of the routes would lock the admin out
  of the session they saved the change from.
- **Editable from the admin panel** (Dashboard → Advanced → Web server
  settings), so it round-trips through `PUT /api/config/admin` → `setConfig` →
  `resolveBasePath`, and the normalized value is what lands in `config.json`.
  Like everything else in that card, it needs a restart to take effect.
- **`offloadStreamPath`/`offloadDownloadPath` are deliberately not prefixed.**
  They address the reverse proxy's own virtual directories, not routes here.
  `mediaStreamBaseUrl`/`mediaDownloadBaseUrl` in `filesystem/utils.ts` *are*
  prefixed — those go to the browser as `<audio>`/`<a href>` sources.
- The reverse proxy must **pass the prefix through, not strip it** (nginx:
  upstream without a trailing slash; Caddy: `handle`, not `handle_path`). See
  `README.md` → *Serving under a sub-path*.

Covered by `test/base-path.ts`.

### 2.5 Scanning System (`filesystem/`)

Scanning runs in a **child process** (`child_process.fork`) for isolation:

1. **Socket.IO** in `socket.ts` listens for client events: `PERFORM_SCAN`, `PERFORM_UPDATE`, `PERFORM_WORK_FILE_SCAN`, `KILL_SCAN_PROCESS`, `ON_SCANNER_PAGE`.
2. It forks the appropriate scanner script (`scanner.ts`, `updater.ts`, or `workFileScanner.ts`); each child is bound to `scannerModules.ts`.
3. The child process communicates via `process.send()`; the parent relays any `m.event` it receives to all connected clients via `io.emit(m.event, m.payload)`. The event list is in §7.
4. `scannerModules.ts` contains the heavy lifting: reading directories, parsing file structures, scraping DLsite, and upserting into the DB.

Only one scanner process can run at a time (guarded by `scanner` variable in `socket.ts`; all three `PERFORM_*` handlers go through the one `startScanner` helper).

**Progress events carry one entry each, never the accumulated array.** The original events (`SCAN_MAIN_LOGS`, `SCAN_TASKS`, `SCAN_RESULTS`, `SCAN_FAILED_TASKS`, all plural) re-sent the *entire* accumulated array on every single line, which is quadratic in the number of lines. **Which runs this actually hurt is worth knowing, because it is not the one you would guess:** `performScan` calls `LOG.main` a constant ~8 times and only adds a result for non-skipped works, so a scan is fine. It is `PERFORM_UPDATE` (a result per work, so the array grows to the whole library) and `PERFORM_WORK_FILE_SCAN` (`扫描进度：i/total` per work) that push a library's worth of entries through the channel N times over. Deltas keep each message the size of its own line, which is also what makes per-image logging affordable.

The three pieces that keep it that way:

- **Deltas.** `SCAN_MAIN_LOG` / `SCAN_TASK_ADD` / `SCAN_TASK_LOG` / `SCAN_TASK_REMOVE` / `SCAN_FAILED_TASK` / `SCAN_RESULT` each carry their own entry. The frontend appends.
- **A bounded snapshot.** `SCAN_INIT_STATE` is the one event carrying accumulated state, and it is sent on every page load *and* every reconnect — so the child keeps only a tail (`MAX_MAIN_LOGS` 500, `MAX_TASK_LOGS` 200, `MAX_FAILED_TASKS` 200, `MAX_RESULTS` 500 in `scannerModules.ts`). `Scanner.vue` mirrors the same caps, since its log panel is not virtualised.
- **A log file.** `filesystem/scanLog.ts` writes the complete, uncapped run to `dataRoot/logs/scan-<timestamp>-<run>.log` (`scan` / `update` / `files`), keeping the last 10 runs. `LOG.open(runName)` starts it and prints the path as the run's first line, so the page names where the untruncated version lives. Writes go through a bare fd with `writeSync` on purpose: a scan ends in `process.exit()`, which does not drain a `WriteStream`, and the tail of a long run is exactly the part worth keeping. Every failure path is swallowed — a read-only data root must not stop a scan.

**The scan outcome outlives the socket.** `socket.ts` remembers the last `SCAN_FINISHED`/`SCAN_ERROR` in `lastScanEvent` and replays it when `ON_SCANNER_PAGE` arrives with no scanner running; `Scanner.vue` re-emits that on Socket.IO's `connect`, so a reconnect resyncs. **A multi-hour scan only needs the socket to drop once**, from any cause — a suspended laptop, a locked phone, a wifi handover, a proxy reload — and Socket.IO reconnects with a *fresh* socket that missed the terminal event. There is no total connection time limit to work around (verified against `engine.io` 6.6.9: `pingInterval` 25s / `pingTimeout` 20s, client side 45s since the last packet; `connectTimeout` 45s and `upgradeTimeout` 10s cover only the handshake and the polling→WebSocket upgrade; nothing caps a socket's lifetime). The heartbeat is also real traffic every 25s, so a *quiet* scan cannot idle out of an nginx `proxy_read_timeout` either. The gap was purely that nothing resynced after a reconnect. A clean child exit whose `SCAN_FINISHED` never made it out (see `LOG.finish`) synthesises one, and `KILL_SCAN_PROCESS` with no live scanner answers the same way instead of throwing on `null` — which used to take the server down with it.

> **A page stuck on `running` is not always the page's fault.** The scan can genuinely never finish: `retryGet` (`scraper/axios.ts`) arms its cancel-token timeout around `axios.get`, which with `responseType: 'stream'` resolves as soon as **headers** arrive — so `clearTimeout` fires before a single body byte is read, and `saveWorkImageToDisk` then pipes the stream with no timeout at all. A remote that accepts, sends headers and stalls hangs that promise forever, holds its `limitP` slot, and with `config.maxParallelism` of them the run stops without ever reaching `LOG.finish`. The per-image log lines are the diagnostic: a hung run stops mid-count and the log file names the file and URL it died on.

### 2.6 Scraping (`scraper/`)

- **DLsite** (`dlsite.ts`): Primary scraper. Fetches work pages, parses HTML with Cheerio. Every request site addresses the work by `workno(id)`, so the **books floor** (`BJ…`, 成年コミック/出版社 — publishers whose ASMR releases get a `BJ` number instead of `RJ`) needs no separate scraper: `maniax/work/=/product_id/BJ….html`, `maniax/api/=/product.json?workno=BJ…` and `maniax-touch/product/info/ajax` all serve books works, returning `site_id: books`, `work_type: SOU`. Two floor differences that do matter: covers live under `images2/work/books/BJ…` rather than `work/doujin/RJ…` (same round-up-to-next-1000 bucket — see `guessDLsiteCoverUrl`), and `maker_id`/`series_id` come back as `BG…`/`TITLE…` instead of `RG…`/`SRI…`. The latter is a non-issue because `resolveLabel` keys every label off the **name** (see §2.3): the scraper no longer emits a circle/series id at all, matching `fanza.ts`. It used to `parseInt` the storefront id into a field nothing read — which quietly became `NaN` on the books floor. A publisher lands in `t_circle` like any circle — the UI calls it a Circle.
- **ASMR.one** (`asmrOne.ts`): Secondary source. **Doujin floor only** — it is keyed by bare digits, so a `BJ` id is rejected up front rather than silently resolving to the `RJ` work of the same number and storing another work's metadata. Same guard in `hvdb.ts`.
- **HVDB** (`hvdb.ts`): Another metadata source. Doujin only; see above.
- **Fanza** (`fanza.ts`): Scrapes Fanza (DMM) doujin detail pages. Uses age-check cookies to bypass the adult interstitial. Takes a work id in either spelling, addresses the detail page by `fanzaCid()` (`cid=d_215444`), and returns the canonical `d215444` on the metadata object.
- All scrapers use a shared Axios instance (`axios.ts`) with proxy support, retry logic, and configurable timeouts.

### 2.7 Routes (`routes/`)

All routes mounted under `/api`:

| File | Path | Description |
|------|------|-------------|
| `auth.ts` | `/api/auth/*` | Login, current user, password change |
| `credentials.ts` | `/api/credentials/*` | User CRUD (admin only) |
| `version.ts` | `/api/version/*` | App version, changelog |
| `config.ts` | `/api/config/*` | Get/set server config |
| `media.ts` | `/api/media/*` | Stream audio (range requests), download, lyric sidecar lookup |
| `metadata.ts` | `/api/*` | List works, search, sort, filter; work metadata, tracks, covers, images; label lists; `PUT /api/work/:id` admin metadata edit; `PUT /api/work/:id/file-metadata` admin per-file edit |
| `review.ts` | `/api/review/*` | Create/update/delete reviews, ratings, progress |
| `play_history.ts` | `/api/history/*` | Save/load playback state |
| `track_progress.ts` | `/api/track-progress/*` | Per-track playback position, keyed by relPath |

> **Route note:** the label-list routes (`/api/circles`, `/api/tags`, `/api/vas`, `/api/illustrators`, `/api/script_writers`, `/api/series`) are registered as **literal-path loops** over a `FIELDS` array in `metadata.ts` (a `for...of` loop registering one `router.get` per field), with the segment coming from `ROUTE_SEGMENT(field)` — `${field}s` for all but `series`, which is already plural. Express 5 (path-to-regexp v8) no longer supports regex char-classes in route strings, so the old `/:field(circle|tag|va|...|series)s/...` single-regex-route form was replaced. Each handler receives its `field` via closure.

### 2.8 Media Streaming (`routes/media.ts`)

- **Resolution is a database lookup, not a directory walk** — `resolveTrack` reads `t_work_file` (§2.9-0). It is on every media request, so this was the single largest filesystem cost in the app.
- Audio files are streamed using `fs.createReadStream` with range request support (206 Partial Content for seeking).
- Cover images served from `covers/` directory.
- File listing traverses the work directory and returns track info (name, duration, format).

### 2.8b Multi-speaker lyrics

`routes/utils/lyrics.ts` (`findLyricTracks`) resolves which lyric files belong to
an audio track. For `01 Track.mp3` it accepts, extension case-insensitive:

| Name | Meaning |
|------|---------|
| `01 Track.lrc` / `01 Track.mp3.lrc` | the track's only lyric stream (the stem form wins if both exist) |
| `01 Track.1.lrc`, `01 Track.2.lrc`, … | one stream per speaker |

Extensions rank `.lrc` > `.srt` > `.vtt`; `.ass` is listed in the file tree but
is never parsed for playback. **When any numbered file exists the numbered set
wins** and an unnumbered file is ignored, so a whole-track transcript can sit
beside a per-speaker split without both being drawn. A numbered candidate is
dropped when a sibling *media* file already owns that name (a folder with both
`01.mp3` and `01.2.mp3` must not read `01.2.lrc` as speaker 2 of `01.mp3`).

There is no established convention for this: LRC and SRT have no per-line
speaker field, so several speakers means several files. WebVTT does have one —
the `<v Name>` voice span — and a single `.vtt` using it is split into
per-speaker streams by the **frontend** parser instead (`AudioElement.vue`);
the backend still returns it as one entry. The numbers here are positional only
and are never shown: a voice span is the only thing that names a speaker on
screen, so numbered streams are told apart by colour alone.

Covered by `test/lyric-discovery.ts`. To diagnose a real folder — which files
match, which are orphaned and why, and whether each one parses — run
`npm run check:lyrics -- <folder>` from the repo root.

### 2.9-0 The file listing lives in the database (`t_work_file`)

A work's file list used to be rebuilt by walking the folder **on every request**. `getTrackList` walks, and `resolveTrack` (`routes/utils/track.ts`) calls it — so every stream, download, `check-lrc` and track-progress write cost a directory walk, not just the work page. On a network mount that is latency × file count, on works that run to hundreds of files.

It now comes from `t_work_file`, keyed `(work_id, rel_path)`. Measured on a 43-file work: first read 1 walk, every read after it **0**, and five media requests **0** where it used to be one each.

**`filesystem/workFiles.ts` is the only way in.** It returns exactly the shape `getTrackList` returns, so nothing below it changed:

| function | for |
|---|---|
| `listWorkTracks(workId, workDir, {indexedAt, dbApi})` | the read path — routes and scripts |
| `indexWorkFiles` | the lazy one-off index: walks, but **never probes** — ffprobe belongs to a scan, not a request |
| `rescanWorkFiles` | all three scan paths — walk, probe what changed, relist, in one step, so a scan cannot refresh one and forget the other |

Every entry point takes an optional `dbApi` (defaulting to the live database), the same convention `scripts/backfill-progress.ts` uses, so tests inject an in-memory knex.

- **`getTrackList` is still the filesystem walker** — it is just no longer on the request path. Only the scan paths and the one-off indexing call it.
- **Ordering must not drift.** The rows carry `rel_path` only; `title`/`subtitle`/`ext` derive from it, and the list is sorted with the *same* `natural-orderby` comparator `getTrackList` uses. It decides the order of every file tree in the UI, so `test/work-file-listing.ts` asserts the two produce an identical sequence. Change one comparator, change both.
- **`files_indexed_at` on `t_work`, not a row count.** NULL means never indexed, so the first read walks once and persists — exactly what every read did before — and a genuinely empty work is not re-walked forever.
- **A plain walk never overwrites a duration or a title with NULL.** They cost an ffprobe and a model call respectively, so `indexWorkFiles` carries forward whatever the existing row held for any path still present. Only a scan sets them.
- **Row writes are one transaction** (`replaceWorkFiles`): delete, insert chunked at 100 rows (SQLite's bound-parameter cap), stamp `files_indexed_at`. A half-written listing would otherwise read as complete.

> **A file deleted on disk stays listed until the next scan, and playing it 404s.** Previously it silently vanished from the tree. This is the deliberate trade for not touching the filesystem on reads — the "scan file changes" button is the fix. A work whose folder is *unmounted* now lists its tracks and 404s on play, where before the tree was empty.

Migration `20260913000000` seeds the table from `memo` — pure data movement, **no filesystem access** — and leaves `files_indexed_at` NULL so each work completes its own listing on first read. Memo covers audio only (`scrapeWorkMemo` filters to `supportedMediaExtList`), which is why the completion walk is needed for lyrics, images and PDFs. Measured on a real library: 30,476 rows across 1,804 works in 4s, every duration preserved.

### 2.9a Per-file facts: `t_work_file`, not `t_work.memo`

`duration`, `mtime` and `track_title` are **columns on the row they describe** (§2.9-0). `t_work.memo` is gone — dropped in migration `20260914000000` after `20260913000000` moved its three live keys onto the rows. Its fourth key, `isContainLyric`, was written on every scan and read by nothing, so it simply went.

**Everything is keyed by relPath.** `t_work_file.rel_path`, `t_track_progress.track_key`, and the tail of a `trackId` (`${workId}/${relPath}`) are all the same string. It is normalized to forward slashes at the one place it is built (`getTrackList`), so a Windows server keys a file the same way a Linux one does.

**Durations are the expensive thing, and `mtime` is the invalidation key.** `probeAudioDurations` (`filesystem/utils.ts`) runs ffprobe — one subprocess per audio file — only where a file's mtime no longer matches what the row recorded. It takes the previously known values and hands the new ones back; storage is `filesystem/workFiles.ts`'s job. The mtime test is deliberately separate from "this row has no duration": a file may simply have failed ffprobe, which says nothing about its contents, and folding the two together would re-probe it on every scan forever.

**`getTrackList` is a pure walker.** No memo parameter, no duration or track-title merge — those come from the rows. Keeping storage out of the walker is what allowed the request path to stop touching the filesystem at all.

> **Removed: the content hash.** `memo.contentHash` held a CRC32 per file and `t_track_progress` was keyed by it, on the theory that a rename should not lose a position. It was deleted in migration `20260912000000` because it never bought that: its own cache was invalidated by mtime, so a content change that preserved mtime left a stale hash forever — the hash inherited mtime's trust level while costing a full read of every audio byte on the first open of a work. It also made *global* content identity a liability rather than a feature, since reused SE/BGM/trial tracks are byte-identical across works and one work's position could overwrite another's (which is why the progress lookup is compound `(work_id, track_key)` — still necessary, as two works can share a relPath too). The accepted trade-off is that renaming or moving a file loses that track's position; `track_title` exists so display names need no renaming on disk. `scripts/rekey-track-progress.ts` is the opt-in recovery tool for rows that migration could not convert, and is the only place CRC32 still lives.

### 2.9b Track Titles (`t_work_file.track_title`)

Works whose audio files are named `01.mp3` / `#2.wav` show only the filename. `t_work_file.track_title` is the display name for the row's file, written out-of-band by `scripts/extract-track-titles.ts` through `db.setTrackTitles` — a targeted update rather than `replaceWorkFiles`, which would drop rows the extractor never looked at:

- `filesystem/workFiles.ts` exposes it on a track as **`trackTitle`**, alongside `duration`. `toTree` carries it onto the audio node.
- **`trackTitle` is a separate field, never a replacement for `title`.** `title` is the real filename and `toTree` builds the offload stream/download URLs from it — overwriting it breaks playback.
- Frontend renders `item.trackTitle || item.title`, with the filename demoted to a caption when a title exists (`WorkTree.vue`).
- `GET /api/tracks/:id` reads the rows the title lives on; `PUT /api/work/:id/file-metadata` writes them.

**Editing by hand: `PUT /api/work/:id/file-metadata`** (`routes/metadata.ts`), admin-gated exactly like `PUT /api/work/:id`. Body is `{ files: { <relPath>: { trackTitle } } }`; a title that trims to empty is stored as `NULL`, which shows the filename again. Only the relPaths in the body are touched, and `setTrackTitles` scopes its update by `work_id`, so a relPath belonging to another work matches no row.

> **Named for the table, not the field.** `t_work_file` is a different table and cardinality from `t_work`, so track titles could not be another key in `PUT /api/work/:id` — its validators require the whole metadata object and `editWorkMetadata` *replaces* every label relationship, so a stale dialog would revert scraped tags. `/files` was rejected as ambiguous with replacing the listing. `EDITABLE_FILE_FIELDS` is the whitelist; `duration`/`mtime` are excluded because a scan re-derives them.

**Proposing titles: the `SUGGEST_TRACK_TITLES` socket event** (`socket.ts` → `suggest-track-titles.ts`), not a route. Answers `SUGGEST_TRACK_TITLES_RESULT {workId, titles, trackCount, source, unverified}` or `SUGGEST_TRACK_TITLES_ERROR {workId, error}`. `titles` is an **ordered list**, not a per-file mapping — placement is the dialog's job. `source` is `structured` when DLsite's own list lines up, `llm` otherwise. It writes nothing; the dialog applies it via `PUT /api/work/:id/file-metadata`. `GET /api/config/shared` carries `llmConfigured` (a boolean, never the settings) so the button only appears where it works.

> **Why a socket, not a route.** A local model routinely outruns a proxy's request timeout (nginx 60s, Cloudflare 100s). `emit` returns immediately and the answer arrives as its own event, so no request has a duration to cap — the same reason scanning works this way (§2.5).
>
> **It borrows the transport, not the scanner's concurrency model.** No forked child, no global guard, no replay: this is per-work and in-process, so the reply goes back with **`socket.emit`, never `io.emit`** — broadcasting would drop one admin's suggestion into another's dialog. The echoed `workId` lets a dialog ignore an answer it no longer wants.
>
> **The handshake is already admin-only** (`socket.ts` rejects any account but `admin` when `config.auth` is on), so the handler needs no gate — but the client must not connect app-wide, or every ordinary user gets an error notification. `EditTrackTitles.vue` connects lazily on first use.
>
> **A socket handler has no `workIdParam()`**, so the id is checked against `WORK_ID_RE`/`normalizeWorkId`, now exported from `routes/utils/validate.ts`. A second copy of that regex would drift from the contract in §6.

**The extraction pipeline lives in `track-titles.ts`**, shared by the socket handler and the CLI. **It touches no database** — `suggest-track-titles.ts` is the orchestration layer — which is what lets `test/track-titles.ts` run without one. `callModel` takes `{verbose}`; the CLI dumps the exchange to stdout, printing `messages` as text since `JSON.stringify` escapes the newlines that carry the prompt's structure.

> **Count tracks, not files — `distinctTrackNames`.** A work usually ships its tracks more than once (`NO_SE/`, a wav copy) under identical names. Keying on the distinct file name is what keeps the totals honest and the structured fast path reachable; the chosen title fans back out to every file with that name at the write step. Two genuinely different tracks sharing a basename collapse into one — use `--dry-run` on an unfamiliar layout.

> **The LLM call owns its own HTTP timeouts.** Node's global `fetch` defaults `headersTimeout` and `bodyTimeout` to 300s, and `bodyTimeout` covers the gap *before the first token* — prompt evaluation, which a large `num_ctx` on CPU can exceed, killing the request while the model still worked. `llmAgent` sets both to `0` (undici: no timer), leaving `AbortSignal.timeout(KIKO_LLM_TIMEOUT_MS)` as the only ceiling. `undiciFetch` rather than the global, because a dispatcher must come from the same copy of undici. `callModel` also streams (keeping generation off that clock, `readModelStream`) and unwraps `err.cause`, since every transport failure is otherwise the same opaque `TypeError: fetch failed`.


> **The `htmlToText` sentinel must not be U+0000.** Cheerio parses an appended string as HTML and the tokenizer drops NUL, so the original sentinel never reached the tree: every block ran together and a `<br />` with no trailing source newline lost its break. It is U+E000 now, stripped from the input first.

**Populating it in bulk is out-of-band.** `scripts/extract-track-titles.ts <workId>` is a standalone CLI, not a server feature — it writes straight to the database with no review step, which is right for a terminal and wrong for a web request. It handles **exactly one work per run** (deliberately: the output is a judgement call worth eyeballing before it lands in the DB, and the works needing it are a few circles, not a library sweep). It reads `description` + `description_parts`, and:

1. **Structured fast path** — if `description_parts[].tracks[]` has as many titles as the work has **distinct track names** (not audio files — see above), it pairs them in disk order with no model call. That covers ~16% of works.
2. **Model path** — otherwise it asks an OpenAI-compatible endpoint (`KIKO_LLM_BASE_URL` / `KIKO_LLM_API_KEY` / `KIKO_LLM_MODEL`, env only) to align titles to filenames.
3. **Verbatim validation** — every returned title must appear, whitespace-insensitively, in the description *or* the structured track titles. This is the guard that makes unattended runs safe; a paraphrased Japanese title is indistinguishable from a real one once stored.

> **Two prompts, one set of rules.** `SYSTEM_PROMPT_MAPPING` (`{tracks:[{file,title}]}`) is the CLI's, which validates a per-file mapping. `SYSTEM_PROMPT_LIST` (`{titles:[…]}`) is the dialog's, which places by position and never reads a mapping — echoing filenames back was ~44% of the model's output for nothing, on the phase that dominates a run. `SHARED_RULES` holds the wording that governs quality; only the shape and the skip rule differ (the list variant must **not** skip, or a gap shifts every later title). Selected by `callModel(..., { mapping })`.
>

> **Two guards, same reason.** `validate` is strict and belongs to the CLI, which writes unattended. `collectTitles` is lenient and belongs to the dialog, where the admin reviewing the textarea is the check — and where dropping a title would leave a *gap* that shifts every later one onto the wrong file. It reports `unverified` instead, so a refusal arrives flagged rather than vanishing.

> **`isVerbatim` retries with the track marker stripped.** Small models copy the title but rewrite the numbering (`①　はじまり` → `1. はじまり`), and rejecting that threw away good answers. The stripped form must keep two non-space characters, or `01.` reduces to `''` and matches anything; there is deliberately no length floor on the exact match, since a short title (`朝`) must still pass.

> **The haystack must include the structured titles.** `descriptionToText` strips `ul.work_tracklist` out of `description` so titles are not duplicated in the prose — validating against prose alone rejects every structured work. `buildHaystack` joins both.

Every precondition failure is loud and exits non-zero — unknown id, no scraped description, no audio on disk, unconfigured root folder, or titles already present without `--force`. The caller named the work explicitly, so silently doing nothing would be the wrong answer; the uninformative-filename check is advisory only, printed but never a skip. `--dry-run` prints the result, then asks `write N titles? [y/N]` so an expensive model call need not be repeated to apply it; without a TTY it never writes.

### 2.9c Per-track position: newest observation wins

**One accessor, two projections.** `trackProgressFor(username, {workId | relPaths})` owns the query, the columns and the row shape; `getTrackProgress` (map for one work, for `GET /api/tracks/:id`) and `applyTrackProgressSeconds` (the parked track per history row, for `GET /api/history` and `/api/work/:id`) are projections over it. They had already drifted — the first selected `updated_at`, the second did not — so the work page's file tree and its info panel disagreed about the same position, and the same resume behaved differently depending on which page you started from. `test/progress-projections.ts` asserts they cannot disagree again. The two *endpoints* still return different shapes on purpose: a list view must not pull a whole file tree per row just to read one number.

`applyTrackProgressSeconds` exposes `state.secondsObservedAt` beside `state.seconds`, which is what lets a client tell whether its own local copy is newer.

`t_track_progress` is keyed `(user_name, work_id, track_key)` where `track_key` is the relPath (§2.9a), and `upsertTrackProgress` applies a write only when it is at least as new as the row it would replace:

```sql
DO UPDATE SET ... WHERE excluded.updated_at >= t_track_progress.updated_at
```

**The timestamp is the client's observation time, not the arrival time.** That distinction is the whole point. A write deferred by an offline queue arrives late carrying an old position, so ordering by arrival would let the stale value win — and it would win hardest in exactly the case the deferral exists to serve. The client sends `observedAt` (epoch ms); a request without it falls back to server-now, which reproduces the old unconditional overwrite, so an un-updated client still works.

**It reuses `updated_at` rather than adding a column.** Nothing read that column — the two selects took `track_key`/`seconds`/`completed` only — so there was nothing to migrate, and no `dbVersion` bump. `getTrackProgress` now returns it as `observedAt` so a client holding a local copy can tell which side is newer.

> **The stored representation is load-bearing.** It must stay **UTC text in `CURRENT_TIMESTAMP`'s own format** (`'YYYY-MM-DD HH:MM:SS'`, produced by `utcStamp`). Every pre-existing row holds text, and SQLite orders *all* integers below *all* text regardless of value — so storing epoch milliseconds here would make every new write compare as older than every old row and the guard would silently reject all of them. Keeping the format also means the `strftime(..., 'localtime')` display conversion (`queries.ts`) still applies. Second resolution means two writes in the same second tie, and `>=` lets the later arrival through; `'…SS.mmm'` would still sort correctly if finer resolution is ever wanted.

Client clock skew is accepted rather than defended against: comparisons are client-to-client, and for the single-device case that is the *same* clock, so ordinary drift cancels out. There is no clamp against a deliberately wrong clock.

### 2.9d Transcription (`asr.ts`, `transcribe-work.ts`)

An external ASR server turns a work's audio into subtitle sidecars. One
endpoint is required, `POST <KIKO_ASR_BASE_URL>/transcribe` — audio in,
subtitle out — so the model behind it is swappable.

**Env only, never `config.json`**, as with the LLM settings (§2.9b): `GET /api/config/admin` strips only `md5secret`/`jwtsecret`.

| Variable | Meaning |
|----------|---------|
| `KIKO_ASR_BASE_URL` | e.g. `http://127.0.0.1:8000`. Its presence is what `asrConfigured` reports |
| `KIKO_ASR_QUERY` | query string, appended untouched. Default `format=vtt` |
| `KIKO_ASR_API_KEY` | optional bearer token |
| `KIKO_ASR_TIMEOUT_MS` | per track, default 30 min |

**The query string is opaque**, so a server's own knobs stay reachable and the
app cannot infer the format from it — the **response Content-Type decides the
extension**: `application/x-subrip`→`.srt`, `text/vtt`→`.vtt`,
`text/plain`→`.txt`, anything else refused. That check is what stops a
forgotten `format=` writing JSON into a `.srt`. `.txt` is not a lyric extension
(§2.8b), and the reference server sends `text/plain` for both `format=lrc` and
`format=txt`, so the header cannot say which arrived.

`TRANSCRIBE_WORK` may carry `relPaths` (limits the run; matched against the
work's listing, never joined onto a path) and `query`, which `mergeQuery` folds
onto `KIKO_ASR_QUERY` **key by key** — `hotwords` is per-work by nature, and
replacing would drop `format=vtt` with it. `URLSearchParams` does the escaping
and the result is assigned to `url.search`, which does not re-encode: non-ASCII
becomes percent-escapes, and `#` becomes `%23` rather than truncating the query
into a fragment.

**`undici.request()`, not `fetch()`, and both timers off.** The upload needs a
`Content-Length` — a stream body goes out chunked otherwise, which the
reference server rejects, and `fetch()` drops the header as forbidden. The raw
body carries no filename, so `X-Filename: x.<ext>` names the container.
`headersTimeout` defaults to 300s and this endpoint sends no headers until the
whole file is transcribed, so both timers are `0` with
`AbortSignal.timeout(KIKO_ASR_TIMEOUT_MS)` as the only ceiling — the trap
`callModel` hit from the other side (§2.9b).

**The library first, an overlay second.** `writeSidecar` attempts the write
next to the audio and falls back to `config.lyricFolderDir/<workId>/<relPath>`
on `EROFS`/`EACCES`/`EPERM` — attempted rather than probed, since
`fs.access(W_OK)` is a TOCTOU and root passes it on a directory it cannot
write. Both go through a temp file and a rename. The overlay is a sixth data
folder (§2.4) so a read-only library mount stays supported.

**Reading it back costs nothing per request.** `mergeOverlay` in
`filesystem/workFiles.ts` folds the overlay into the walk at index time, so
readers see one listing and `findLyricTracks` needs no changes. There is no
`overlay` column: `trackPath` in `routes/utils/track.ts` joins `workDir` first
and the overlay second, only for a subtitle extension. That ordering is the
"library copy wins" rule; a file in both places collapses to the library's at
merge time, since `rel_path` is the primary key.

**Driven over Socket.IO** (§7): a work runs minutes to hours. One track at a
time — the reference server transcribes serially and returns `503` past its
queue depth. A track with a sidecar is skipped, a silent track writes nothing,
and the run re-indexes once at the end.

`overwrite` (off by default, so a re-run costs nothing for tracks already done)
transcribes those tracks anyway; the write then replaces whatever is at that
path. It is the only way to replace an overlay file, which lives under the data
root out of the user's reach. `writeSidecar` refuses when the work folder
already holds that sidecar and cannot be written to — the existing copy would
shadow anything put in the overlay, so the write would be a silent no-op. `transcribeWork` takes an optional
`dbApi`, as in `filesystem/workFiles.ts`.

Covered by `test/transcription.ts`, which uses undici's `MockAgent` so the
suite needs no socket.

### 2.9 Work-Page Extras (description, images, author, reviews)

The DLsite scraper reads more than the `#work_outline` spec table. The description and the images are served by `GET /api/work/:id/extras` and `GET /api/image/:id/:name` and rendered on the work page (`WorkDescription.vue`, `WorkGallery.vue`); **the scraped DLsite reviews and `authors[]` are still unexposed** — scaffolding for later features. Everything below is DLsite-only; `fanza.ts` is unchanged and Fanza works get none of it, so a Fanza work shows no description tab.

**Scraped fields** (`scraper/dlsite.ts`, returned on the metadata object):

| Field | Source | Notes |
|-------|--------|-------|
| `authors[]` | `作者` row of `#work_outline` | The creator credit on works with no VA/illustrator/scenario breakdown. Rarely set. `{id: nameToUUID(name), name}`, same shape as `vas`/`scriptWriters`. |
| `description` | `div[itemprop="description"]` | **The block's markup, as the seller wrote it**, stored unsanitized — the allowlist lives at the serving end (see below). The JSON fallback still writes plain text here (`intro_s` is all it has), as do rows scraped before this. |
| `descriptionParts[]` | same block, per `.work_parts` | `{type, heading, images[], tracks[]}`. `type` comes from the `type_*` class: `text`, `image`, `tracklist`. The per-part `text` is gone — the markup carries it — but `images[]` still drives the downloader and `tracks[]` still feeds the track-title extractor. |
| `descriptionParts[].tracks[]` | `.work_parts.type_tracklist` | `{title, time}`. **Only ~16% of works use this structured part** (measured over 40 random library works: 16% structured, 43% track list written as prose inside a `type_text` part, 40% no track list). The prose case is still captured — as `text` under a heading like `☆トラックリスト&プレイ内容` — but `tracks[]` is empty for it, and the numbering varies wildly (`Track1`, `①`, bare `1`, `◆01`). Parsing that is the LLM's job, not the scraper's. |
| `descriptionParts[].type` | the `type_*` class | Seen in the wild: `text`, `image`, `multiimages`, `tracklist`, `list`. Unknown types still parse — the type is recorded and text/images extracted generically. |
| `sampleImages[]` | `.product-slider-data div[data-src]` | `{url, thumb, width, height}`. The slides are rendered client-side by Vue, so the visible `<img>` tags are **not** in the HTML — only these empty data divs are. The first slide (`_img_main`) is dropped; it is the cover. |

The JSON fallback (`scrapeStaticWorkMetadataFromDLsiteJson`) fills the same fields from `product.json`: `creaters.created_by`, `intro_s` (a plain-text summary DLsite has already truncated — no parts, no track list) and `image_samples`.

> The JSON scraper read `creaters.illust` / `creaters.scenario`; the API keys are `illust_by` / `scenario_by`, so that path silently dropped illustrators and script writers. Fixed alongside `created_by`.

**Reviews** — `scrapeWorkReviewsFromDLsite(id, {order, limit, maxPages})`. Reviews are rendered client-side and are absent from the work page HTML; the endpoint the Vue component calls is `GET /{site}/api/review?product_id=RJ…&order=regist_d&limit=…&page=…&locale=ja_JP`. It paginates until a short page, de-duplicating by `member_review_id` (a "pickup" review repeats across pages). Each review carries `genres` — genres **the reviewer** picked, independent of the seller-chosen work genres.

> A region-restricted work returns `{is_success: true, error_msg: ""}` with no `review_list` and serves a stripped work page (no description, no slider, no review section). That is indistinguishable from "no reviews" at the API level, so a scrape from a blocked IP silently yields empty extras rather than an error.

**Markup in, text out.** The scraper stores what DLsite served and flattens nothing; the two consumers each take what they need:

- **The work page** gets it through `sanitizeDescriptionHtml` (`routes/utils/description-html.ts`), called by `GET /api/work/:id/extras`. Allowlisted tags and attributes only, `script`/`style`/`iframe`/form controls removed with their subtree, unknown tags *unwrapped* (their text is the blurb), `on*` and every unlisted attribute dropped, `javascript:`/`data:` links unwrapped to their label, external links marked `target=_blank rel="noopener noreferrer"`, and each `<img>` rewritten to `${config.basePath}/api/image/:id/:file` — **along with the `<a>` DLsite wraps around it**, so clicking the picture opens the local copy rather than leaving for img.dlsite.jp — or removed when the file was never downloaded (an `<a>` left holding nothing goes with it). Nothing on the page hotlinks DLsite. Matching the stored entry to the markup is scheme-insensitive (`imageKey`): DLsite writes `//img.dlsite.jp/…` while `absoluteAssetUrl` stored `https://img.dlsite.jp/…`, and an exact match finds nothing and silently drops every image. The wrapping `<a href>` is the second place the file is looked up, since `parseDescriptionParts` prefers it (the link is the full-size original, the `<img>` may be a resized copy). **Colours are stripped** (`color`, `background`, anything with `url()`), while layout declarations — `text-align`, `font-size`, `font-weight`, … — survive: sellers pick colours for DLsite's white page and this app has a dark theme. Covered by `test/description-html.ts`.
- **`scripts/extract-track-titles.ts`** owns the flattening now (`htmlToText`, cheerio + the `<br>` sentinel that keeps DLsite's `"<br />\n"` from doubling every line break). It needs no detection: plain text passed through `htmlToText` comes back out unchanged.

**Sanitizing on the way out, not at scrape time, is the load-bearing choice.** An allowlist always needs adjusting; doing it here fixes the whole library at once, while a scrape-time filter would leave every stored work carrying whatever the old rules let through until it was scraped again.

**No migration and no second column.** The markup lands in `description`, replacing the flattened text, and a rescan or refresh upgrades a row in place. Until then old rows still hold text, so `looksLikeHtml` (a lone `/<[a-z][^>]*>/i`) decides which way a row goes out: markup rows are sanitized into `descriptionHtml` and text rows go out as `description` for the client's plain-text path, which keeps their line breaks and the images and track list the old scraper pulled out separately. Exactly one of the two is ever populated.

**Storage** — `db.getWorkExtras(id)`, `db.setWorkSampleImages(id, list)`, `db.replaceWorkDlsiteReviews(id, reviews)`, `db.getWorkDlsiteReviews(id)`. Reviews are **replaced**, not merged: DLsite lets reviewers edit and delete, and the rows carry no local state.

**Images on disk** — `config.imageFolderDir` (default `images/`, sibling of `covers/`, with the same relative-path and `imageUseDefaultPath` handling). `collectWorkImages(metadata)` in `filesystem/utils.ts` is the single source for *which* images a work has and *in what order* — slider first, then description images, deduplicated by url — shared by the downloader and by the refresh merge in `queries.ts`. Named by position, not by remote basename: `RJ<id>_img_smp<N>.<ext>` for slider images and `RJ<id>_img_part<N>.<ext>` for images embedded in description blocks — description images are served under opaque hash names that collide across works. `deleteWorkImagesFromDisk(id, [keep])` matches that exact pattern rather than a bare prefix, so pointing `imageFolderDir` at the cover folder cannot delete covers; the optional `keep` set is what turns it into the post-download prune (below) instead of a full wipe.

**Editable from the admin panel** (Dashboard → Advanced → scanner settings) as an inverted "download work extras" toggle — the stored key is the skip, the switch reads as the thing it enables. **`config.skipWorkExtras` (default `true`) switches off the two expensive halves** — the image downloads and the review scrape — on every **implicit** path: library scans, `refreshAll` (the Scanner page's update button), and `POST /api/refresh/:id`. Together they are what makes a scan expensive (N image downloads plus paginated review requests per work) and what gets it rate-limited by DLsite. It does **not** gate the explicit `updater.ts --images` / `--reviews` flags — naming one on the command line is already opting in. A missing config key counts as "skip".

**Description, `description_parts` and the sample-image URL list are never gated.** They are parsed from the work page the scanner already fetches, so they cost no extra request, and `scripts/extract-track-titles.ts` needs the description to work at all. The switch controls network cost, not what gets parsed.

**When it runs** (`filesystem/scannerModules.ts`):

| Trigger | Description + author | Sample-image URLs | Image download | Reviews |
|---------|---------------------|-------------------|----------------|---------|
| New work during `PERFORM_SCAN` | ✅ | ✅ | ¹ | ¹ |
| `PERFORM_UPDATE` (= `updater.ts --refreshAll`) — **whole library** | ✅ | ✅ | ❌ | ❌ |
| `POST /api/refresh/:id` — **one work** | ✅ | ✅ | ¹ | ¹ |
| `updater.ts --images` | ✅ | ✅ | ✅ | ❌ |
| `updater.ts --reviews` | ❌ | ❌ | ❌ | ✅ |

¹ Only when `config.skipWorkExtras` is `false`; it defaults to `true`, so out of the box no images are downloaded and no reviews fetched. The first two columns are unaffected by the switch.

Downloads and review pagination cost extra requests per work, so they deliberately do **not** ride along with `refreshAll` — the UI's update button would otherwise turn into thousands of image fetches. `--refreshAll` still writes the image *list* (URLs, `file: null`); a later `--images` fills in the files.

> **A refresh without a download merges the image list; a download overwrites it.** The two halves are separate writers and the order matters.
>
> 1. `updateWorkMetadata`'s `includeDescription || refreshAll` branch (`updater.ts --refreshAll` / `--description`, the Scanner page's update button, `POST /api/refresh/:id`) rebuilds the list from `collectWorkImages(metadata)` and **carries the `file` of each already-downloaded image across by url**. It used to assign the scraped slider list wholesale, which dropped every `file` **and** every description-image entry — those only exist because the download added them. With `skipWorkExtras` on (the default) nothing re-downloads afterwards, so pressing "Refresh metadata" silently orphaned a work's images and blanked its gallery. Covered by test 11 in `test/edit-metadata.ts`.
> 2. When the download does run, `saveWorkImages` → `setWorkSampleImages` **replaces** the list right afterwards, so the merge above is invisible on that path: every image is re-fetched and renamed by position, and the fresh list is the truth.
>
> **The scanner downloads a work's images one at a time; a refresh does not.** `downloadWorkImages` takes `{ concurrency }`, defaulting to **1** — which is what the scanner gets, because it already runs `config.maxParallelism` works at once and per-work parallelism multiplies out (16 works × 10 images was ~160 concurrent requests at img.dlsite.jp, enough to get the whole scan rate-limited). `POST /api/refresh/:id` passes `REFRESH_IMAGE_CONCURRENCY` (4): one work, nothing else running, and a user waiting on a button. Images are ~1MB each, so on a slow link the wait is transfer time and the cap is ~4×; on a fast or CDN-warm one it makes no difference. The limiter is `limit-promise`, already used by `scannerModules.ts` and `filesystem/utils.ts`.

> **A download reuses what is already on disk.** Images are ~1MB each and are fetched one at a time, so refetching a work's whole set is most of what a refresh costs. `splitDownloadTargets` keeps a target when the **previous** stored list said that same url lives in that same file *and* the file is still there; everything else is fetched. The url match is what makes it safe — names are positional, so `_img_part2` holds a different picture as soon as the description gains or loses one, and "the file exists" alone would keep the wrong bytes forever. `saveWorkImages` reads the stored list and passes it down, so `downloadWorkImages` itself stays free of the database. Measured on RJ01029894 (7 images): 3.3s to fetch, 0.0s on the next refresh. Covered by `test/work-images.ts`.

> **The download also prunes.** File names are positional (`_img_part3`), so inserting or removing one image renumbers every image after it, and last run's copies stop being referenced by anything. `downloadWorkImages` ends by calling `deleteWorkImagesFromDisk(id, keep)` with the names *this run claimed* — including names whose fetch failed, since an older copy there is the best thing available to the next attempt — and deletes the rest. Without it, a work whose description keeps changing accumulates orphans nothing will ever serve or delete. The no-download refresh path never deletes anything: a url that vanishes from the description just leaves a file behind, which the next `--images` run prunes. Covered by `test/work-images.ts`.

> **Two different refresh paths, don't confuse them.** `PERFORM_UPDATE` (Scanner page button → `socket.ts` → forks `updater.ts --refreshAll`) iterates **every** row of `t_work` and skips the network-heavy extras. `POST /api/refresh/:id` (`WorkDetails.vue`) refreshes **one** user-initiated work and does everything, including image download and review scraping. It calls `db.updateWorkMetadata` directly and never touches `scannerModules`, so the `includeImages`/`includeReviews` option handling in `updateMetadata` does not apply to it — it calls `filesystem/workExtras.ts` itself.

**`filesystem/workExtras.ts`** holds `saveWorkImages(id, metadata, log)` and `saveWorkReviews(id, log)`, shared by the scanner child and the refresh route. It is deliberately **not** in `scannerModules.ts`: requiring that from a route would pull in the child-process IPC plumbing (it reassigns `process.send`) and the scan concurrency limiter. The logger is injected — the scanner passes an adapter onto `LOG.task` so progress shows on the Scanner page, the route passes the console default. `downloadWorkImages` mkdirs `config.imageFolderDir` itself, since a library upgraded but never rescanned has no `images/` directory and the route can be the first writer.

Both are non-fatal in the route: `db.updateWorkMetadata` has already committed by the time they run, so a failed image fetch returns a partial success rather than a 500 implying nothing was saved. The response carries `{images, reviews}` counts.

---

## 3. Critical Conventions & Gotchas

- **SQLite:** No concurrent writes. Foreign keys and the busy timeout are set per connection in the `afterCreate` hook in `database/knexfile.ts` (`PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout = config.dbBusyTimeout`).
- **Migrations:** Sequential, timestamp-prefixed files in `database/migrations/`. Run automatically on **every** startup via `knex-migrate.ts` (`init.ts`), on knex's own migration engine; `knex_migrations` records the executed ones, so only pending migrations run (idempotent — no version bump required for a migration to be picked up). The manifest in `database/migrations/index.ts` reports upstream's original `.js` filenames, so a database written by the CommonJS version never re-runs a migration and stays interchangeable with upstream. The app-version comparison in `init.ts` gates only the version-keyed upgrade tasks (`applyFix`/`fixMigrations` in `upgrade.ts`, `updateConfig`) — those must run **before** `up` because they can mark migrations as executed (`skipAll`). `dbVersion` in `schema.ts` must always equal the latest migration's timestamp prefix (asserted by `test/migration..ts`).
- **Config write protection:** `setConfig()` always overwrites `production`, `md5secret`, `jwtsecret` with current values — these cannot be changed through the admin panel. (`jwtsecret` is now unused: sessions are opaque random strings, not signed tokens. It is retained only so the config file shape does not change.)
- **Error handling:** auth failures are raised as an `Error` with `name = 'UnauthorizedError'` → 401 with `WWW-Authenticate` header. Missing DB tables → 500 with "数据库结构尚未建立". Production mode sanitizes error messages (no stack traces).
- **API cache policy:** `api.ts` sets `Cache-Control: private, no-cache` on **every** `/api` response, before the auth middleware so 401s get it too. `private` is the load-bearing part: RFC 9111's protection for authenticated requests only covers the `Authorization` header, **not cookies**, and this app is now cookie-authenticated — so without it a shared cache (an nginx `proxy_cache` in front of the app) could store per-user responses like `/api/auth/me`, `/api/history`, and `/api/review` and serve one user's data to another, since nginx does not key on `Cookie` by default. `no-cache` rather than `no-store` so the browser may still store and revalidate, preserving Express's ETag 304s. Routes wanting real caching override it with `res.setHeader` inside the handler.
- **Cover cache headers (`routes/metadata.ts`):** `/api/cover/:id` overrides the API default via `res.sendFile`'s `maxAge`, which emits `Cache-Control: public, max-age=2592000` (30 days). `public` is deliberate and fine here — covers are site-wide content with nothing user-specific in them, so a shared cache storing one leaks nothing. Per-user JSON is covered by the `private, no-cache` default above.
  - **The missing-cover fallback gets `COVER_FALLBACK_MAX_AGE` (5 min), not the long one.** A work scraped after its placeholder was cached would otherwise show `no-image.jpg` for 30 days. This is the rule that actually matters — don't collapse the two branches into one `maxAge`.
- **Child process IPC:** Uses `process.on('message')` / `process.send()`. Parent (Socket.IO) relays events to all connected clients.
- **Scanner concurrency:** Only one scanner child process runs at a time, guarded by the in-memory `scanner` variable in `socket.ts` (not a lock file). Subsequent `PERFORM_*` events are ignored while a scan is in progress. Because that guard is in memory, it does not survive a restart — so the scanner child exits on `process.on('disconnect')` (`scannerModules.ts`) when the parent dies. Node otherwise keeps a forked child running after the IPC channel closes, and killing only the server (`kill <pid>`, or a supervisor restarting the parent — Ctrl+C and `docker stop` reach the whole process group and were never affected) left it scanning invisibly: logs going to a dead channel, and a restarted server willing to start a second scan beside it. Two scanners rewriting one work's `t_work_file` rows at once is silent data loss, since `replaceWorkFiles` deletes before inserting.
- **Update lock file:** `upgrade.ts` maintains `update.lock` in the config folder for the one-time upgrade/migration process (e.g. `fixVA`). Its state is surfaced as `lockFileExists` in the `/api/version` response — this is unrelated to scan concurrency.
- **Express 5 migration notes:** `res.sendFile`/`express.static` now reject paths containing dot-segments unless `dotfiles: 'allow'` — `routes/media.ts` passes `{ dotfiles: 'allow' }` to its `res.sendFile` calls to preserve v4 behavior for user audio paths. `express-validator` is on **v7**, where `.optional({ nullable: true })` became `.optional()`. `req.body` is `undefined` (not `{}`) before body parsing. Async route handlers have rejected promises forwarded to the error handler automatically.
- **Metadata editing (admin only):** `PUT /api/work/:id` (`routes/metadata.ts`) is gated by `config.auth && req.user.name !== 'admin'` → 403. When `config.auth` is false, all requests act as admin and editing is unrestricted. The handler validates the body with `express-validator` and delegates to `db.editWorkMetadata(workId, data)`, which runs in a single Knex transaction and **replaces** (not merges) the tag/VA/illustrator/script-writer/series relationships for the work, then re-fetches via `db.getWorkMetadata`.
- **Label id conventions:** **All** label tables (`t_circle`, `t_tag`, `t_va`, `t_illustrator`, `t_script_writer`, `t_series`) use **name-based UUID** ids, resolved/created by the unified `resolveLabel(trx, table, name)` helper in `queries.ts` (deterministic `nameToUUID(name)` + `INSERT OR IGNORE`). Explicit numeric ids emitted by scrapers (DLsite RG/genre/SRI ids) are ignored. When editing metadata, list elements are normalized to `{id?, name}`, trimmed, and de-duplicated by name; `id` is optional (the server resolves or creates the row by name).

---

## 4. Dependencies

No native modules, and no `node_modules` at runtime: esbuild inlines every
dependency into `build/` and the database driver is a Node built-in.

| Dependency | Purpose |
|------------|---------|
| `knex` | Query building and migrations, run by `database/knex-migrate.ts` on knex's own migration engine |
| `node:sqlite` (built-in) | Database driver via `database/node-sqlite-client.ts` — replaces the `sqlite3` addon |
| `axios` + `cheerio` | HTTP scraping + HTML parsing |
| `cookie-parser` + `cookie` | Session cookie parsing (Express and Socket.IO) |
| `socket.io` | Real-time events (scan progress, transcription, track-title suggestions) |
| `jschardet` | Text encoding detection for LRC files |
| `natural-orderby` | Natural sorting of filenames. Kept rather than replaced: `Intl.Collator` orders differently, which would reorder every track list |
| `undici` | The LLM call (§2.9b) and the ASR upload (§2.9d), so both of its 300s timeouts can be switched off — and, for the upload, so a `Content-Length` survives beside a stream body. Everything else uses the global `fetch` or `axios` |
| `tunnel-agent` | CONNECT tunnelling for HTTPS through an HTTP proxy, which axios's native proxy support cannot do |
| `compare-versions` | Version comparison for config migration |
| `express`, `compression`, `connect-history-api-fallback`, `express-validator`, `mime-types` | HTTP layer |
| `serve-index` (devDependency) | Dev-only static file listing; never bundled |

Removed, replaced by Node built-ins or the local modules under `lib/`: `sqlite3`,
`dotenv`, `md5`, `lodash`, `url-join`, `yargs`, `limit-promise`, `uuid`,
`htmlparser2`, `string-random`, `mocha`, `chai`, `nodemon`. The full
before/after table with the reason for each is in [`../UPSTREAM.md`](../UPSTREAM.md).


---

## 5. Scripts

```bash
npm start             # Run the server from source (node app.ts)
npm run start:bundle  # Run the bundled deployment unit (node build/app.mjs)
npm run dev           # node --watch, development
npm run scan          # Run scanner manually
npm run build         # esbuild bundle -> build/ (scripts/build.ts)
npm run typecheck     # tsc --noEmit
npm test              # ESLint + typecheck + node:test (explicit file list, see §9)
npm run test:bundle   # Build build/ and smoke-test it outside the repo

# Metadata refresh (filesystem/updater.ts). Flags are mutually exclusive —
# the first one set wins.
node filesystem/updater.ts --refreshAll     # dynamic + all static metadata (what PERFORM_UPDATE runs)
node filesystem/updater.ts --author         # 作者 only
node filesystem/updater.ts --description    # description + image list, no downloads
node filesystem/updater.ts --images         # implies --description, then downloads the images
node filesystem/updater.ts --reviews        # re-scrape every DLsite user review

# One-off recovery after migration 20260912000000 (relPath track keys). Opt-in
# because it reads every audio file of the affected works -- the cost that
# migration removed from the request path. --purge discards instead.
node ./scripts/rekey-track-progress.ts --dry-run
```

> **Packaging:** the `pkg` single-executable build is gone — its
> `backend/package.json` block, `scripts/pkg-package.js` and the launcher's exe
> branch were removed. `backend/scripts/build.ts` bundles the backend into
> `backend/build/`: `app.mjs`, the three forked scanner entry points, the two
> bundled maintenance CLIs, their shared chunks, plus copies of `dist/` and
> `static/`. That directory is the deployment unit — the container image copies
> only it, and `scripts/package.js` zips it with a pinned Node 26 `node.exe`,
> ffmpeg/ffprobe and `Kikoenai.bat` for Windows (built on any host OS via
> `npm run package:windows`; see root `README.md` and
> `.github/workflows/package-windows.yml`). Nothing in the bundle is native or
> needs `node_modules`. Data folders resolve to `KIKO_DATA_DIR || appDir` (see
> `config.ts`).


---

## 6. API Contract (Exposed to Frontend)

Every route mounted under `/api`, as of the 1.0 freeze. **This table is the contract** — keep it exact, and mirror any change into `frontend/AGENTS.md` §6.

**Id formats:** work-id route params (`:id` on `/api/work`, `/api/cover`, `/api/tracks`, `/api/media/*`, `/api/refresh`, `/api/scan`, `/api/review`, `/api/history`, `/api/track-progress`) are **strings** matching `WORK_ID_RE` = `^(bj\d{6,8}|\d{6,8}|d_?\d+)$` (case-insensitive) — DLsite doujin ids are already RJ-padded digit strings, DLsite books ids keep their `BJ` prefix, Fanza ids are `d`-prefixed and underscore-free. `workIdParam` in `routes/utils/validate.ts` validates and sanitizes them (the legacy `d_` spelling and 7-digit ids self-heal), so a stale PWA cache or an old bookmark (`/work/d_215444`) keeps resolving. Label ids are UUID v5 of the label's own name, so they are no longer addressable as route params: `/api/<field>s/:id` still resolves a *name*, but filtering by label goes through `/api/search` (§2.3b).

**Work id is always a path param.** No route takes `work_id` in a body or query string; `workIdBody`/`workIdQuery` are gone.

### Auth & users

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Liveness probe. The only route reachable without a session besides login |
| `/api/auth/me` | GET | Current user + auth status |
| `/api/auth/me` | POST | Log in; sets the session cookie, returns `{ user, session }`. Public |
| `/api/auth/logout` | POST | Destroy the server-side session and clear the cookie |
| `/api/credentials/users` | GET | List users (admin only) |
| `/api/credentials/users` | POST | Create a user (admin only). Body `{name, password, group}` |
| `/api/credentials/users` | PUT | Change a password (admin, or the user's own). Body `{name, newPassword}`; revokes every session for that user |
| `/api/credentials/users` | DELETE | Delete users (admin only). Body `{users: [{name}]}`; refuses the built-in `admin` |

### Works, search & labels

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/works` | GET | List works. Query `page`, `order`, `sort`, `nsfw`, `seed` → `{works, pagination}` |
| `/api/search` | GET | Filter search — `filter` is the advanced filter syntax (§2.3b), e.g. `va:"name$" -tag:NTR`. Same response shape as `/api/works` |
| `/api/work/:id` | GET | Work metadata + playback state |
| `/api/work/:id` | PUT | Manually edit metadata — title, nsfw, release, circle, tags[], vas[], illustrators[], scriptWriters[], series (admin only) |
| `/api/work/:id/file-metadata` | PUT | Set editable fields on the work's `t_work_file` rows. Body `{files: {<relPath>: {trackTitle}}}`; an empty title clears to NULL. Only the named rows and whitelisted fields are touched (admin only) |
| `/api/work/:id/extras` | GET | Scraped work-page extras: `{description, descriptionHtml, descriptionParts, sampleImages}`. The stored `description` column goes out as **one or the other**: markup is **sanitized here, per request** (`routes/utils/description-html.ts`) and returned as `descriptionHtml` with `description: ''`; a plain-text row (older scrape, or the JSON fallback) is returned as `description` with `descriptionHtml: ''`. Kept off `/api/work/:id` because that row is assembled by `assembleWorks`, shared with every list endpoint, and a description dwarfs the rest of a work's metadata. 404 when the work is unknown; a work with nothing scraped returns empty values, not a 404 |
| `/api/tracks/:id` | GET | `{tree, trackProgress}` — see the note below |
| `/api/cover/:id` | GET | Cover image. Query `type` (`main`\|`sam`\|`240x240`\|`360x360`). 30-day `public` cache; the `no-image.jpg` fallback gets 5 minutes |
| `/api/image/:id/:name` | GET | One scraped sample/description image from `config.imageFolderDir`. `name` must match `workImageFileNamePattern(id)` (`filesystem/utils.ts`, shared with `deleteWorkImagesFromDisk`) — caller-supplied, so it is matched, never sanitized. 30-day `public` cache like covers. **404 with no placeholder when the file is absent.** The frontend only asks for images whose stored entry has a `file`, and **never falls back to the remote DLsite url** — an undownloaded image is simply not shown, rather than hotlinking img.dlsite.jp from every viewer's browser |
| `/api/circles` `/api/tags` `/api/vas` `/api/illustrators` `/api/script_writers` `/api/series` | GET | List all labels of that kind, ordered by name |
| `/api/circles/:id` … `/api/series/:id` | GET | Resolve one label id (UUID) to its row; 404 otherwise |
| `/api/scan/:id` | POST | Re-walk one work, re-probe changed durations, and rewrite its `t_work_file` listing → `{files}`, the re-listed track count. Was `{memo}`, which no longer exists — see §2.9a |
| `/api/refresh/:id` | POST | Re-scrape one work from DLsite/Fanza: metadata (`refreshAll`), then sample/description images and DLsite reviews. Returns `{message, metadata, images, reviews}` where `images`/`reviews` are counts. Image and review failures are non-fatal (metadata is already committed) |

> **The six label route segments are `ROUTE_SEGMENT(field)` in `metadata.ts`**, which is `${field}s` for everything except `series` (already plural). They are registered as a **literal-path loop** over `FIELDS`, because Express 5 (path-to-regexp v8) dropped regex char-classes in route strings; each handler gets its `field` by closure.

### Playback, progress & reviews

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/history` | GET | Works the user has playback history for. Query `excludeFinished` (`all`\|`listened`, default `listened`): when `listened`, excludes rows where `t_review.progress='listened'`. Items carry a nullable `progress` |
| `/api/history/:id` | PUT | Save playback state. Body `{state}` (the serialized queue + index; carries no position) |
| `/api/history/:id` | DELETE | Delete this work's playback history |
| `/api/track-progress/:id/*path` | PUT | Report per-track position. Body `{seconds, completed, observedAt?}` — `observedAt` is epoch ms for when the client *measured* the position, and the write is applied only if it is at least as new as the stored one (see §2.9c). Omitting it falls back to server-now, i.e. the old unconditional overwrite. The track is addressed exactly as the media routes address it, so the client posts to `/api/track-progress/${encodeTrackId(trackId)}` and carries no second identifier. The path is resolved against the work's track list, so a path that is not a file of this work is a 404 rather than a row keyed by junk |
| `/api/review` | GET | Works the user has reviewed/rated/progress-marked. Query `filter` (one of the five progress values) |
| `/api/review/:id` | PUT | Create/update review, rating, or progress. Query `starOnly`, `progressOnly`, `autoMark`. With `progressOnly=true&autoMark=true` it only writes `progress='listened'` when existing progress is null/empty/marked/listening; no-op on listened/replay/postponed |
| `/api/review/:id` | DELETE | Delete the whole review row (rating + review_text + progress) |
| `/api/review/:id/progress` | DELETE | Clear only `progress` (set NULL), preserving rating/review_text. If the row has no rating **and** no review_text (e.g. an auto-marked rating-null row), the whole row is deleted to avoid an all-NULL empty row |

### Media

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/media/stream/:id/*path` | GET | Stream one file (Range supported). Redirects to the reverse proxy when `config.offloadMedia` is on, except `.txt`/`.lrc`, which Express serves itself for `jschardet` charset detection |
| `/api/media/download/:id/*path` | GET | Same file as an attachment |
| `/api/media/offline/:id/*path` | GET | The best offline-friendly copy of a track: a lossless source (`.wav`/`.flac`) is transcoded to Opus on first request and cached on disk under `config.transcodeCacheDir`; lossy audio and text are served as-is. Always served by Express, never offloaded — the proxy maps to the original file and has no place for a cached transcode. 503 when `config.enableTranscoding` is off |
| `/api/media/check-lrc/:id/*path` | GET | Lyric sidecars for a track → `{result, message, lyrics: [{trackId, lyricExtension}]}`, one entry per speaker — see §2.8b |

> **`*path` is the work-relative path, and it is the file's one identity.** A
> `trackId` is `${workId}/${relPath}`, so the same value identifies a file,
> addresses it in every media URL, and keys its `t_track_progress` row — the
> client needs no second field. Express 5 hands a `*path` back as an array of
> already-decoded segments, so `relPath = req.params.path.join('/')`.
>
> **A trackId must be percent-encoded into a URL** (`encodeTrackId`, `routes/utils/url.ts`, mirrored in `frontend/src/base-path.js`). A relPath is a file name, so it contains URL *syntax*: a work whose tracks are named `#1.序章♡….opus` (RJ01639521) truncated the path at the fragment marker and 404'd on files that existed. `?` and `%` are the same class. Per segment so `/` survives; `encodeURI` is **not** enough, since it leaves `#` and `?` alone by design. Both ends must encode identically or `toQueueItem`'s mediaStreamUrl comparison stops matching. Covered by `test/urljoin.ts`.
>
> **The offload path still has the defect.** `joinFragments`'s relative branch is unencoded and pinned that way by `test/urljoin.ts`, so a `#`-prefixed work will 404 under `config.offloadMedia`. Left alone because that URL addresses the reverse proxy's own virtual directory and is untestable from here — and `offloadMedia` is not a supported deployment today (defaults off, undocumented). Encode it and update those tests if the feature is revived.
>
> `routes/utils/track.ts` (`resolveTrack`) is the single resolver for all four
> routes. It matches the joined path against `getTrackList`'s `shortFilePath`,
> i.e. against a directory walk the server did itself — **caller input is never
> joined onto a path**, so traversal cannot escape the work folder. A miss is a
> 404. `shortFilePath` is normalized to forward slashes at the one place it is
> built, so a Windows server keys a file the same way a Linux one does.
>
> **One deliberate legacy branch:** a single path segment of pure digits is read
> as the old positional index. That handle is what play-history queues written
> before migration `20260912000000` still carry, and stored user data cannot be
> refetched the way a client cache can — 71% of rows in the author's database
> were older than per-track progress and would otherwise have stopped playing.
> It is unambiguous because a tracked file always carries a supported extension
> and so always contains a `.`.
>
> **Do not expect these rows to age out.** A stored queue is only rewritten in
> the new form when it is rebuilt from the tree, which happens in `WorkTree.vue`
> via `toQueueItem` — i.e. when the user plays from the work page. Resuming from
> Recent Works or Favourites hands the *stored* queue to `SET_QUEUE` and
> `PUT /api/history/:id` persists it back unchanged, so a work that is only ever
> resumed keeps its legacy handles forever. Retiring this branch therefore needs
> a deliberate one-off normalizer that resolves each legacy handle against the
> work's file list (the same index → relPath step `resolveRelPath` in
> `scripts/backfill-progress.ts` already does), not the passage of time.
>
> The index it replaces was an offset into the work's sorted, filtered file list,
> which includes text, image and pdf files. Adding a lyric sidecar renumbered
> every later track and silently repointed stored queues at the wrong file;
> `DELETE /api/history/:id` exists because of it. Inherited from upstream, where
> the same value was misleadingly called `hash`.

### Config & version

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/config/shared` | GET | Public config subset (seek times, `enableTranscoding`, `llmConfigured`, `asrConfigured`) |
| `/api/config/admin` | GET | Full config minus `md5secret`/`jwtsecret` (admin only) |
| `/api/config/admin` | PUT | Write config; `production`/`md5secret`/`jwtsecret` are never writable (admin only) |
| `/api/version` | GET | `{current, lockFileExists, lockReason}`. Local only — no GitHub call |

> **Tracks response:** `GET /api/tracks/:id` returns `{ tree, trackProgress }`
> instead of a bare array. Every node carries `trackId` (`${workId}/${relPath}`)
> and `relPath` — text, image and pdf nodes too, since the path is the identity
> rather than a debugging extra. `trackProgress` is a
> `{trackId: {seconds, completed}}` map, keyed by the same handle the nodes carry,
> so a progress badge needs no second lookup key. **It reads no audio bytes.**
> **Superseded twice, both worth knowing:** hashing was briefly split into a
> separate `GET /api/work/:id/memo` that the frontend merged in afterwards, and
> the gap let a queue be committed — and persisted to `t_play_history` — before
> the hashes arrived, permanently silencing per-track progress for that row since
> the resume-from-history path never refetches the tree. That was fixed by
> hashing inline here, which made the first open of a work read every audio byte
> (450MB+ for a wav-heavy work). Both problems were the content hash being used
> as identity; see §2.9a.

> **Note:** Library scanning is **not** a REST endpoint. The frontend triggers it over Socket.IO (`PERFORM_SCAN` / `PERFORM_UPDATE` / `PERFORM_WORK_FILE_SCAN`) and listens for the `SCAN_*` events (§7). `POST /api/scan/:id` is unrelated — it re-reads one work's files, it does not scrape.

### Removed at the 1.0 freeze

Each of these was a compatibility shim or a one-shot tool, deleted before the API stability promise rather than after:

| Gone | Was | Why |
|------|-----|-----|
| `GET /api/me` | 302 → `/api/auth/me` | Shim for PWA bundles cached before the auth routes moved |
| `check-lrc` flat `trackId`/`lyricExtension` | duplicated the first `lyrics[]` entry | Shim for bundles cached before multi-speaker lyrics |
| `POST /api/backfill/progress` | replayed history into `t_review` + `t_track_progress` | One-shot migration for installs predating `t_track_progress`. The CLI (`scripts/backfill-progress.ts`) stays |
| `POST /api/debug/playback` | logged arbitrary client JSON to the console | Mobile-playback debugging aid; unbounded, unauthenticated when `config.auth` was off, and had no callers |
| `GET /api/:fields/:id/works` | label-filtered work list | Label filtering goes through `/api/search` |
| `GET /api/work/:id/memo` | hashes, fetched separately | See the tracks note above |

Renamed in the same pass: `/api/credentials/user` → `/users` (all four verbs now agree), `/api/seriess` → `/api/series`, `POST /api/work/scan/:id` → `POST /api/scan/:id`, and `work_id` moved out of every body/query into the path on `/api/review`, `/api/history` and `/api/track-progress`.

---

## 7. Monorepo Integration

The frontend builds directly into `backend/dist/` (configured via `distDir` in `frontend/quasar.config.js`) and is served as static content by Express.

- **Workspace scripts:** from root, `npm run dev:backend` (node --watch), `npm run build` (frontend + bundle), `npm start` (source) and `npm run start:bundle -w backend` (the bundle).
- **Socket.IO events (scanning):**
  - Client → server: `PERFORM_SCAN`, `PERFORM_UPDATE`, `PERFORM_WORK_FILE_SCAN`, `KILL_SCAN_PROCESS`, `ON_SCANNER_PAGE` (sent on mount **and on every reconnect** — it is the resync point)
  - Client → server, unrelated to scanning: `SUGGEST_TRACK_TITLES` `{workId}` — propose a track list for one work (§2.9b). Per-work and in-process, not a forked child
  - Client → server, likewise: `TRANSCRIBE_WORK` `{workId}` and `TRANSCRIBE_CANCEL` — transcribe one work's audio (§2.9d). One run per socket; a disconnect aborts it
  - Server → client (relayed from the scanner child process), each carrying one entry:

    | Event | Payload |
    |-------|---------|
    | `SCAN_MAIN_LOG` | `{entry: {level, message}}` |
    | `SCAN_TASK_ADD` | `{rjcode}` |
    | `SCAN_TASK_LOG` | `{rjcode, entry: {level, message}}` |
    | `SCAN_TASK_REMOVE` | `{rjcode, result}` |
    | `SCAN_FAILED_TASK` | `{task: {rjcode, result, logs}}` |
    | `SCAN_RESULT` | `{result: {rjcode, result, count}}` |
    | `SCAN_INIT_STATE` | `{tasks, failedTasks, mainLogs, results}` — the **only** accumulated payload, and capped; answers `ON_SCANNER_PAGE` |
    | `SCAN_FINISHED` | `{message}` — replayed from `lastScanEvent` after a reconnect |
    | `SCAN_ERROR` | none |

  - Server → **the asking socket only** (`socket.emit`, not `io.emit`):

    | Event | Payload |
    |-------|---------|
    | `SUGGEST_TRACK_TITLES_RESULT` | `{workId, titles, trackCount, source, unverified}` |
    | `SUGGEST_TRACK_TITLES_ERROR` | `{workId, error}` |
    | `TRANSCRIBE_PROGRESS` | `{workId, relPath, status, overlay?, error?}` — one per track, `status` ∈ `running`/`written`/`skipped`/`empty`/`failed` |
    | `TRANSCRIBE_RESULT` | `{workId, written, skipped, failed, empty, overlay, cancelled}` |
    | `TRANSCRIBE_ERROR` | `{workId, error}` |

  - **Gone:** the plural `SCAN_MAIN_LOGS` / `SCAN_TASKS` / `SCAN_RESULTS` / `SCAN_FAILED_TASKS`, which re-sent the whole accumulated array on every line. See §2.5.
  - Scanning is **not** exposed over REST; there is no `/api/scanner` endpoint.

---

## 8. Common Development Tasks

### Adding a new route
1. Create route file in `routes/` exporting an Express Router.
2. Add it to `routes/index.ts` with an ESM import and `router.use('/path', newRoute)`.
3. Routes under `/api` are automatically protected by the session middleware in `api.ts`. Note its skip list is matched against `req.path`, which is **relative to the `/api` mount** (`/auth/me`, not `/api/auth/me`).

### Adding a database migration
1. Create the file in `database/migrations/` with a timestamp prefix (e.g., `20260802000000_my_migration.ts`). It is a static ESM module, not a directory-scanned one.
2. Export `up` and `down` functions following existing patterns.
3. Register it in `database/migrations/index.ts`: one `import * as` line plus one `{ name, up, down }` entry. **The `name` keeps the original `.js` spelling** (`20260802000000_my_migration.js`), because that is what `knex_migrations` already holds in every deployed database; changing it makes the migration run again on upgrades.
4. Bump `dbVersion` in `database/schema.ts` to the new timestamp prefix and update `createSchema` so a fresh DB matches the migrated one.
5. Migration runs automatically on next server startup, logging `Doing migrate on <file>` (and `数据库迁移完成` when the startup is also a version upgrade). Pending migrations run on every boot regardless of version bumps — the `knex_migrations` table is the source of truth, not the app version.

### Adding a new scraper source
1. Create scraper module in `scraper/` following `dlsite.ts` pattern.
2. Integrate into `scannerModules.ts` where metadata is fetched.

### Modifying server config schema
1. Add new key with default in `defaultConfig` in `config.ts`.
2. `updateConfig()` auto-adds missing keys on startup.
3. Add protected fields to `setConfig()` if they should not be runtime-changed.

---

## 9. Testing

- **Framework:** `node:test` + `node:assert` — plain `.ts` files run by Node 26, no mocha/chai
- **Linting:** ESLint flat config (`eslint.config.js`) with `typescript-eslint` and `eslint-plugin-n`
- **Typecheck:** `tsc -p tsconfig.json` (`strict`, `noEmit`)
- **Tests:** Located in `test/` directory:
  - `edit-metadata.ts` — covers the `PUT /api/work/:id` flow and `db.editWorkMetadata` (uses shared `db-test.sqlite3` singleton)
  - `search-query.ts` — advanced filter parser/serializer + `getWorksByFilter` behaviour (builds its own throwaway `db-search-test.sqlite3`)
  - `work-id.ts` — id canonicalization (Fanza + DLsite books), `workno` spelling, cover/image file naming, `getFolderList` work-code detection, and migration `20260828000000` up/down
  - `description-html.ts` — `looksLikeHtml`, and the sanitizer allowlist: tag/attribute filtering, script removal, unknown-tag unwrapping, colour stripping, image rewriting (incl. `basePath`) and link handling
  - `work-images.ts` — `collectWorkImages` ordering/dedup, the `deleteWorkImagesFromDisk` wipe **and** its `keep`-set prune (against a real temp folder), and what `workImageFileNamePattern` will and will not match
  - `work-file-listing.ts` — `t_work_file`: ordering identical to the filesystem walk (the assertion that matters), all tracked file types present, indexed-once-then-no-walk (proved by deleting the folder and reading again), and durations/track titles carried forward across a re-index rather than NULLed
  - `progress-projections.ts` — `getTrackProgress` and `applyTrackProgressSeconds` report the same `seconds` and `observedAt` for the same track; the test that would have caught the `updated_at` drift
  - `track-identity.ts` — relPath as the one file identity: `trackId` construction, non-ASCII and subdirectory paths, forward-slash normalization, `relPath` on every node type, the legacy positional-index branch, migration `20260912000000`, and `scripts/rekey-track-progress.ts` (the only place CRC32 survives)
  - `work-files.ts` — `probeAudioDurations`: reuses a known duration on an unchanged mtime, re-probes when the mtime moved, re-probes a known mtime with no duration (the case a naive guard would skip forever), leaves non-audio alone, and keeps what was known when a file vanishes mid-scan. Also asserts `getTrackList` is a pure walker with no duration or trackTitle of its own
  - `history-seconds.ts` — `applyTrackProgressSeconds` overriding stale history positions, and the compound `(work_id, track_key)` lookup that keeps two works with an identically named file apart
  - `data-root.ts` — `KIKO_DATA_DIR` resolution in a subprocess: relative becomes absolute, each folder nests its name once, and a restart is a no-op
  - `transcription.ts` — the ASR client (Content-Length, `X-Filename`, query merge and escaping, Content-Type → extension, abort vs timeout) against undici's `MockAgent`; the overlay merge into `t_work_file`; `writeSidecar`'s library-then-overlay fallback; and the `transcribeWork` loop
  - `track-titles.ts` — the shared extraction pipeline: `distinctTrackNames`, the verbatim guards, the `htmlToText` sentinel, and `readModelStream`
  - `benchmark.ts` — DB query benchmark; Skips if `backend/sqlite/db.sqlite3` is missing/empty;
  - `migration..ts` — `dbVersion` in `schema.ts` equals the newest migration prefix (the double-dot filename is upstream's, kept)
  - `migration-names.ts` — the manifest reports upstream's original `.js` names, so a database built by the CommonJS version runs no migration twice and stays readable by upstream
  - `node-sqlite-client.ts` — the `node:sqlite` knex client: null-prototype rows, bigint `lastInsertRowid`, boolean/Date bindings, transactions, ALTER/DROP COLUMN, and the missing `reader` flag
  - `lib.ts` — fixed-vector tests for `lib/uuid-v5.ts`, `lib/url-join.ts`, `lib/limit-promise.ts`, plus md5 password-hash compatibility
  - `base-path.ts` — prefix normalization and rewriting of the three prefixed assets
  - `scan-logging.ts` — one message per line, the bounded snapshot and the per-run log file
  - `track-progress-freshness.ts` — newest-observation-wins track-progress writes (a late, older write must not win)
  - `transcode-filename.ts` — the Opus transcode cache name covers file, mtime and encode settings
  - `backfill-progress.ts`, `import-legacy-history.ts` — the two bundled maintenance CLIs
  - `bundle-smoke.ts` — the esbuild bundle booted from outside the repo with no node_modules (run via `npm run test:bundle`, not `npm test`)
- **Run:** `npm test` = ESLint → `tsc` → `node --import ./test/setup-env.ts --test --test-concurrency=1 <explicit file list>`
  - `test/setup-env.ts` is preloaded with `--import`: it sets `NODE_ENV=test` and `FREEZE_CONFIG_FILE=1` before `config.ts` runs its module-init side effects (ESM hoists imports, so a test file cannot do it in time).
  - `--test-concurrency=1` because several suites share the `test/db-test.sqlite3` singleton.
  - **A NEW TEST FILE MUST BE ADDED TO THE EXPLICIT FILE LIST IN `backend/package.json`'s `test` script.** `node --test` is given named files, not the directory, so an unlisted suite silently never runs.
- **Bundle smoke test:** `npm run test:bundle` builds `backend/build/` (`scripts/build.ts`), copies it outside the repository and boots it where no `node_modules` is reachable (`test/bundle-smoke.ts`). Deliberately not part of `npm test`: it runs a full production build.

---

## 10. Development Tips

- **Config freezing:** Set `FREEZE_CONFIG_FILE=1` to prevent config file writes during testing.
- **Docker:** `compose-example.yaml` runs the published image, which already sets `IS_DOCKER=true`, `NODE_ENV=production` and `KIKO_DATA_DIR=/appdata`; compose adds no environment overrides.
- **Database path:** Controlled by `databaseFolderDir` in config, or `dbUseDefaultPath: true` (default).
