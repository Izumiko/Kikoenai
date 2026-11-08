# Kikoenai 后端 TypeScript 化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `backend/` 改造成 strict TypeScript（ESM，Node 26 原生运行 `.ts`），去掉原生模块 `sqlite3`，产出无需 `node_modules` 的打包部署目录，同时与上游 `Rivers47/Kikoenai` 保持逐文件对应。

**Architecture:** 每个 `backend/**/X.js` 变成同路径的 `X.ts`；knex 保留，底层驱动换成基于 `node:sqlite` 的自定义 client；先一次性机械转换为 ESM（文件头 `// @ts-nocheck`），再逐层去掉 nocheck 补类型；最后用 esbuild 打包成扁平的 `backend/build/` 目录。

**Tech Stack:** Node.js 26（原生类型剥离、`node:sqlite`、`node:test`）、TypeScript 6、knex 3、Express 5、esbuild、typescript-eslint。

**Spec:** `docs/superpowers/specs/2026-11-09-typescript-migration-design.md`（执行者必须先读）

## Global Constraints

- Node `>=26`：所有 `engines`、Containerfile、CI 统一。开发直接 `node xxx.ts`，**不得引入 tsx/ts-node/nodemon**。
- 只用可擦除 TS 语法：禁止 `enum`、`namespace`、参数属性、`import x = require()`。相对导入写 `.ts` 扩展名。
- tsconfig：`strict`、`module`/`moduleResolution: nodenext`、`target: esnext`、`erasableSyntaxOnly`、`verbatimModuleSyntax`、`allowImportingTsExtensions`、`rewriteRelativeImportExtensions`、`resolveJsonModule`、`noEmit`。
- 文件路径与文件名保持与上游一致（`test/migration..js` → `test/migration..ts`）。除本计划列出的新文件外不新增、不拆分、不合并文件。
- 不做全量格式化；保留原有注释（含中文）；**新写注释用英文**。
- 行为、REST/Socket.IO 接口、表结构、`config.json` 格式与上游完全一致。
- `knex_migrations` 中的迁移名保持原 `.js` 文件名。
- 生产运行时不得依赖 `node_modules` 或任何 `.node` 文件。
- 每个任务结束时：`npm test -w backend` 全部通过（基线 281 个用例，Task 1 修复后应全部通过），并且 `node backend/app.ts` 能启动。
- 每个任务单独提交，提交信息用英文 conventional commits。

## Review Focus

1. **用上游版本建的已有数据库**：升级后不能重复执行任何迁移（迁移名带 `.js`），也不能丢数据。→ Task 3 测试 `migration names stay compatible with upstream databases`。
2. **node:sqlite 默认值与 sqlite3 不同**：外键约束默认开启、双引号字符串字面量默认禁止。upgrade 环境要求外键关闭，旧迁移里的 raw SQL 可能用了双引号字符串。→ Task 2 测试。
3. **返回行是 null-prototype 对象**：`routes/utils/normalize.js` 里的 `record.hasOwnProperty("state")` 碰到这种对象会直接抛 TypeError。client 必须返回普通对象。→ Task 2 测试。
4. **旧密码哈希与 UUID 兼容**：替换 `md5`/`uuid` 后结果必须逐字节一致，否则所有用户无法登录、标签/声优 id 全部变掉。→ Task 4 固定向量测试。
5. **打包产物脱离源码树运行**：没有 `node_modules`、没有设置 `KIKO_DATA_DIR`、配置了 `basePath` 时，数据目录、`dist/`、`static/no-image.jpg`、fork 出的扫描子进程都要指向产物目录。→ Task 12 冒烟测试。

---

### Task 1: 工具链基线

**Files:**
- Modify: `package.json`、`backend/package.json`、`frontend/package.json`（engines → `>=26.0.0`）
- Create: `backend/tsconfig.json`
- Modify: `backend/test/scan-logging.js:125`（`fs.rmdirSync(x, { recursive: false })` 改成在 Node 26 下合法的等价写法）
- Modify: `backend/package.json` devDependencies：加 `typescript@^6`、`@types/node@^26`（或可用的最新版本）

**Interfaces:**
- Produces: `npm run typecheck -w backend`（= `tsc -p tsconfig.json`）；根 `package.json` 增加 `"typecheck": "npm run typecheck -w backend"`。

- [ ] Step 1：运行 `cd backend && NODE_ENV=test npx mocha test/ --ignore test/benchmark.js`，确认是 280 通过 / 1 失败（scan-logging 的 after-all hook）。
- [ ] Step 2：修复 `scan-logging.js` 的 rmdir 调用，语义不变（只删空目录）。
- [ ] Step 3：创建按 Global Constraints 配置的 tsconfig，`include` 为 `["**/*.ts"]`，`exclude` 为 `node_modules`、`dist`、`build`、`test_data_root`。此时还没有 `.ts` 文件，所以需要 `"files": []` 或者让 tsc 不因"无输入"报错（任选一种）。
- [ ] Step 4：`npm install`，然后 `npm run typecheck` 退出码 0，mocha 281 全部通过。
- [ ] Step 5：提交 `chore: require Node 26 and add TypeScript toolchain`。

### Task 2: 基于 node:sqlite 的 knex client，移除 sqlite3

**Files:**
- Create: `backend/database/node-sqlite-client.js`（CommonJS，Task 3 会一起转换）
- Create: `backend/test/node-sqlite-client.js`
- Modify：所有 `client: 'sqlite3'` / `"sqlite3"` 的位置改为使用新 client：`database/knexfile.js`、`database/knex-migrate.js:18`、`scripts/backport-work-dates.js`、`scripts/import-legacy-history.js`，以及 `test/` 下所有 `knexLib({ client: 'sqlite3', ...})`。
- Modify: `backend/package.json`：删除 `sqlite3` 依赖和 `pkg.assets` 里的 `node_sqlite3.node`。

**Interfaces:**
- Produces: `module.exports = Client_NodeSQLite`（默认导出一个类，可以直接作为 knex 的 `client` 选项传入：`knex({ client: Client_NodeSQLite, connection: { filename }, useNullAsDefault: true })`）。

client 要求：继承 `knex/lib/dialects/better-sqlite3`，`driverName = 'node-sqlite'`。
- `acquireRawConnection`：`new DatabaseSync(filename, { readOnly, enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true })`，与 sqlite3 的默认行为一致。
- `_query`：语句有结果列（`columns().length > 0`）时用 `all`，否则用 `run`。返回的每一行转成**普通对象**。`context.lastID` / `changes` 转成 number。
- 绑定参数沿用父类的 `_formatBindings`（Date 转 valueOf，boolean 转 0/1）。
- `knexfile` 里 `pool.afterCreate` 改为同步执行 `conn.exec('PRAGMA foreign_keys = ON')` 和 `busy_timeout`，然后 `done(null, conn)`；出错时调用 `done(err, conn)`。

- [ ] Step 1：在 `test/node-sqlite-client.js` 写失败测试（mocha + chai，与现有风格一致），用例如下：
  - `returns plain objects`：`Object.getPrototypeOf(row) === Object.prototype`，且 `row.hasOwnProperty('id')` 不抛错。
  - `insert returns [lastID]`：`await knex('t').insert({x:1})` 的结果深等于 `[1]`。
  - `update/del return change counts`。
  - `foreign keys are off by default`：`pragma foreign_keys` 返回 0。
  - `double-quoted string literals are accepted`：`select "abc" as v` 返回 `v === 'abc'`。
  - `transactions commit and roll back`。
  - `alterTable dropColumn works`（会走 knex sqlite DDL 的重建表逻辑）。
  - `booleans and dates bind like sqlite3`：`true` 存为 1，Date 存为毫秒数。
- [ ] Step 2：运行 `NODE_ENV=test npx mocha test/node-sqlite-client.js`，因为模块不存在而失败。
- [ ] Step 3：实现 client，并替换上面列出的所有 sqlite3 用法。
- [ ] Step 4：`npm uninstall sqlite3 -w backend`，然后确认 `grep -rn "sqlite3'" backend --include=*.js`（排除 node_modules）只剩文件名或注释里的字样。全部 mocha 测试通过。
- [ ] Step 5：用一个新的临时数据目录执行 `KIKO_DATA_DIR=$(mktemp -d) node app.js`，确认能启动、能建库，`curl localhost:8888/api/health` 返回 200。然后停止服务。
- [ ] Step 6：提交 `feat(db): replace sqlite3 with a node:sqlite knex client`。

### Task 3: 后端整体机械转换为 ESM `.ts`

这是最大的一步，但每个文件的改法都是机械的。建议先写一个一次性 codemod 脚本（不提交），处理完再手工修正剩下的特殊情况。

**Files:**
- Rename + Modify：`backend/**/*.js` → `.ts`，包括源码、`database/migrations/*`、`scripts/*`、`test/**`。**例外：`backend/eslint.config.js` 保持 JS**（改成 ESM 写法）。
- Create: `backend/database/migrations/index.ts`（迁移清单）
- Create: `backend/test/migration-names.ts`
- Modify: `backend/package.json`：加 `"type": "module"`，同时更新 scripts（见下文）。
- Modify: `backend/database/knex-migrate.ts`：改用 `migrationSource`。
- Modify: `frontend/quasar.config.js:4`：改为 `require('../backend/base-path.ts')`。
- Modify: `backend/eslint.config.js`：改成 ESM，用 typescript-eslint 的 parser 处理 `**/*.ts`。规则沿用现有配置，不引入格式化类规则；`n/` 插件中与 TS 冲突的规则可以关掉。

**Interfaces:**
- Produces: `migrations/index.ts` 默认导出 `MigrationEntry[]`，其中 `type MigrationEntry = { name: string; up: (knex: Knex) => Promise<unknown>; down?: (knex: Knex) => Promise<unknown> }`。`name` 等于原始文件名（例如 `'20210105232420_fix_duplicate_title.js'`），数组按文件名排序。
- Produces: `knex-migrate.ts` 的签名和行为都不变（`knexMigrate(command, flags, progress)`）。`findMigrationFile(prefix)` 改为在清单里查找，返回 `name`。

转换规则：
1. `const x = require('y')` → `import x from 'y'`；解构写法对 Node 内置模块和 ESM 包用命名导入，对 CJS 包用默认导入后再解构（以 Node 能实际加载为准）。相对路径补上 `.ts`。
2. `module.exports = {...}` → 命名导出（不额外加 `export default`），所有导入方改成命名导入。`module.exports = router` 这种只导出单个值的情况改为 `export default`。`knex-migrate.js:129` 的 `module.exports.default` 合并为同一个默认导出。注意：测试会直接修改 `config` 对象的属性（例如 `config.rootFolders = ...`），所以 `config` 必须继续以同一个可变对象导出。
3. `exports.up = ...` → `export const up = ...`。
4. 函数内部的延迟 `require`（`tag-aliases.js:47`、`va-aliases.js:40`、`scripts/test-fanza-scraper.js`、`scannerModules.js:13`）：提到文件顶部 import。`app.js:155-157` 的 `serve-index`（只在开发环境用）改成 `await import('serve-index')`。
5. `require.main === module` → `import.meta.main`。
6. `__dirname` → `import.meta.dirname`（Task 12 会再统一改成 appDir），`__filename` → `import.meta.filename`。
7. 读取 JSON：`require('../package.json')`、`tag-aliases.json`、`va-aliases.json`（`fs.readFileSync(path.join(__dirname, ...))`）全部改成 `import x from './x.json' with { type: 'json' }`。
8. `socket.ts` 里 fork 的脚本路径改成 `./filesystem/scanner.ts` 等。
9. 测试文件：有些测试在 require 之前设置 `process.env.X`（例如 `FREEZE_CONFIG_FILE`、`NODE_ENV`）。ESM 的 import 会被提升到最前面执行，所以要把这些赋值放进一个单独的、最先被 import 的副作用模块，或者在 mocha 配置里统一设置。**不能让测试写入真实的 `config/config.json`。**
10. 测试里 `require(path.join(__dirname, '..', 'config.js'))` 这类子进程脚本：改成 `import()` 加上 `.ts` 路径。
11. 每个转换后的 `.ts` 文件第一行加 `// @ts-nocheck`。

package.json scripts（backend）：
- `start`: `cross-env NODE_ENV=production node --trace-warnings app.ts`
- `dev`: `node --watch --watch-path=. --trace-warnings app.ts`（要排除 `config/`、`sqlite/` 的变化；如果 `--watch-path` 做不到排除，就只监听源码目录）
- `scan`、`backfill:progress`、`import:legacy-history`：对应的 `.ts`
- `test`: `npm run lint && npm run typecheck && cross-env NODE_ENV=test mocha --extension ts 'test/**/*.ts' --ignore test/benchmark.ts --ignore 'test/{helpers,spinup,teardown}/**'`
- 删除 `nodemonConfig` 和 `nodemon` 依赖。`pkg` 段先保留不动（Task 13 再删）。

- [ ] Step 1：在 `test/migration-names.ts` 写测试：
  - `manifest lists every migration with its original .js name`：清单里的 `name` 集合等于 34 个原始文件名，全部以 `.js` 结尾，并且已排好序。
  - `migration names stay compatible with upstream databases`：先往 `knex_migrations` 表插入全部原始 `.js` 名字（模拟用上游版本建的库），然后执行 `knexMigrate('up')`，`progress` 回调一次都不应被调用，`knex_migrations` 的行数也不变。
  - `fresh database migrates to dbVersion`：空库执行 `up` 之后，最后一条迁移的名字以 `schema.dbVersion` 开头。
- [ ] Step 2：执行转换。
- [ ] Step 3：跑 `npm test -w backend`：lint、typecheck 和全部 mocha 用例（包括新加的）都要通过。用例数量不能比转换前少。
- [ ] Step 4：`git ls-files backend | grep '\.js$'` 只应剩下 `backend/eslint.config.js`。`grep -rn "require(\|module.exports" backend --include=*.ts`（排除 node_modules）应该没有结果，`createRequire` 的合理用法除外。
- [ ] Step 5：用新的数据目录执行 `node app.ts`，能启动，`/api/health` 返回 200。然后执行 `npm run build -w frontend`，quasar 构建成功（证明 `quasar.config.js` 能加载 `base-path.ts`）。
- [ ] Step 6：提交 `refactor: convert backend to ESM TypeScript (mechanical, ts-nocheck)`。

### Task 4: 用 Node 内置功能替换第三方依赖

**Files:**
- Create: `backend/lib/limit-promise.ts`、`backend/lib/uuid-v5.ts`、`backend/lib/url-join.ts`，以及对应测试 `backend/test/lib.ts`
- Modify: `app.ts`（dotenv）、`auth/utils.ts`（md5）、`routes/config.ts`（lodash）、`routes/utils/url.ts`（url-join）、`filesystem/updater.ts`、`scripts/extract-track-titles.ts`（yargs）、`filesystem/scannerModules.ts`、`filesystem/utils.ts`、`filesystem/workExtras.ts`（limit-promise）、`scraper/utils.ts`、`database/migrations/20210213233544_fill_va_uuid.ts`（uuid）
- Modify: `backend/package.json`：删除 `dotenv`、`md5`、`lodash`、`url-join`、`yargs`、`limit-promise`、`uuid`、`htmlparser2`、`string-random`。

**Interfaces:**
- Produces: `export default class LimitPromise { constructor(max: number); call<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, ...args: A): Promise<R> }`：最多同时运行 `max` 个任务，其余按 FIFO 排队，与 `limit-promise` 包的行为一致。
- Produces: `export function uuidv5(name: string, namespace: string): string`，基于 `crypto.createHash('sha1')` 实现，遵循 RFC 4122 第 4.3 节。
- Produces: `export default function urljoin(...parts: string[]): string`，在本项目实际用到的输入上与 `url-join@4` 的结果一致。

替换要点：
- dotenv → `try { process.loadEnvFile() } catch (e) { if (e.code !== 'ENOENT') throw e }`。已存在的环境变量优先，不被 `.env` 覆盖（loadEnvFile 本身就是这个行为，已验证）。
- md5 → `createHash('md5').update(str + config.md5secret).digest('hex')`。
- `_.cloneDeep` → `structuredClone`。
- yargs → `util.parseArgs`：保留所有选项名和别名（`refreshAll/all`、`includeNSFW/nsfw`、`includeTags/tags`、`includeVA/vas`、`includeIllustrator/illust` 等，以文件中实际定义的为准），以及 `extract-track-titles` 的位置参数 `<workId>`、`--dry-run`、`--force`，并保持 `strict`。

- [ ] Step 1：在 `test/lib.ts` 写测试，下面的期望值都是用原来的库算出来的固定值：
  - uuidv5，namespace 为 `699d9c07-b965-4399-bafd-18a3cacf073c`：`かの仔` → `e82dac25-569f-54ef-9e6d-8b82fbefc808`，`ASMR` → `62fc73bd-43a2-510c-ab68-18b0761ef814`，`Some Circle (サークル)` → `a24c0426-bced-5924-a8b8-241a06655f1d`
  - md5 摘要：`admin` → `21232f297a57a5a743894a0e4a801fc3`，`パスワード密码` → `30ff8da3bdcf78e2d6e6577237004ce0`，`p@ss word` → `b9b86dad668f10fa8e4a1c4b29d104b3`（直接测 `createHash` 的拼接方式，即 `auth/utils` 的 `md5()` 在 `md5secret = ''` 时的结果）
  - urljoin：`('https://example.com','media','RJ123456','a%20b.mp3')` → `https://example.com/media/RJ123456/a%20b.mp3`；`('https://example.com/','/media/','RJ1')` → `https://example.com/media/RJ1`；`('http://x.org/base/','%E7%94%BB','c.mp3')` → `http://x.org/base/%E7%94%BB/c.mp3`
  - LimitPromise：`max=2` 时同时运行的任务不超过 2 个；按提交顺序开始执行；某个任务 reject 之后，排在后面的任务照常执行；返回值能正确传回调用方。
- [ ] Step 2：运行测试，确认因为模块不存在而失败。
- [ ] Step 3：实现上面三个模块，并完成所有替换。
- [ ] Step 4：`npm test -w backend` 全部通过（包括已有的 `test/urljoin.ts`）。用 `grep` 确认被删掉的包在 `backend/**/*.ts` 里已经没有任何 import。手动执行 `node filesystem/updater.ts --help`，应输出用法说明或正常解析参数，不报错退出。
- [ ] Step 5：提交 `refactor: replace small dependencies with Node built-ins`。

### Task 5–10：逐层去掉 `@ts-nocheck`，补上类型

每个任务的共同要求：
- 去掉文件头的 `// @ts-nocheck`。`tsc` 在 strict 模式下必须通过，**不能用 `any` 糊过去**：确实无法确定类型的地方用 `unknown` 再收窄类型。外部 JSON、数据库行等可以定义 `interface`。全文 `as any` 和 `// @ts-expect-error` 加起来不超过 5 处，每处都要写英文注释说明原因。
- 只改类型。运行时行为不能变：不改逻辑、不改控制流、不调整代码顺序。遇到确实需要改动运行时代码才能通过类型检查的地方，单独写在提交信息里说明。
- 根据需要添加 `@types/*` 开发依赖，例如 `@types/express`、`@types/compression`、`@types/cookie-parser`、`@types/connect-history-api-fallback`、`@types/mime-types`、`@types/mocha`、`@types/chai`、`@types/chai-string`、`@types/serve-index`。
- 跨文件共享的类型放在 `backend/types/`（这是新目录），例如 `types/config.ts`（`Config` 接口）、`types/db.ts`（各张表的行类型）。只在一个文件里用到的类型就地声明。
- 完成标准：本任务涉及的文件里都已经没有 `@ts-nocheck`；`npm test -w backend` 全部通过；`node app.ts` 能启动。
- 提交信息：`refactor(types): type <layer>`。

**Task 5 — 基础层：** `base-path`、`work-id`、`common`、`config`、`upgrade`、`auth/*`、`routes/utils/*`、`lib/*`。
Produces：`types/config.ts` 里导出 `interface Config`，覆盖 `defaultConfig` 的全部字段；`config.ts` 导出 `config: Config`。

**Task 6 — 数据库层：** `database/*`（包括 `queries.ts`、`search-query.ts`、`schema.ts`、`init.ts`、`knexfile.ts`、`knex-migrate.ts`、`node-sqlite-client.ts`），以及全部 34 个迁移文件。
Produces：`types/db.ts` 里导出各表的行类型，例如 `WorkRow`、`CircleRow`、`TagRow`、`VaRow`、`UserRow`、`ReviewRow`、`HistoryRow`、`TrackProgressRow`、`WorkFileRow`、`SessionRow`；`makeQueries(knex: Knex)` 返回值的类型由 TS 自动推断。
迁移文件统一写成 `export const up = async (knex: Knex): Promise<void> => {...}`，内部逻辑一行都不要改。

**Task 7 — 刮削层：** `scraper/*`。

**Task 8 — 文件系统与 ASR：** `filesystem/*`、`asr`、`track-titles`、`suggest-track-titles`、`transcribe-work`。

**Task 9 — 服务层：** `api`、`app`、`socket`、`routes/*`。
请求处理函数用 Express 5 的 `Request`/`Response` 类型。`req.user` 通过声明合并加到 `types/express.d.ts` 里，类型为 `{ name: string; group: string }`。

**Task 10 — 脚本：** `backend/scripts/*`。

### Task 11：测试从 mocha/chai 迁到 node:test

**Files:**
- Modify：`backend/test/**/*.ts` 全部文件（去掉 `@ts-nocheck`，补上类型）
- Modify：`backend/package.json`：删除 `mocha`、`chai`、`chai-string` 及其 `@types`

**Interfaces:**
- Produces：`npm test -w backend` 依次执行 `npm run lint && npm run typecheck && node --test --test-concurrency=1 <测试文件 glob>`。是否加 `--test-isolation=none`，由执行者判断：前提是测试结果不变，而且现在共用 `test/db-test.sqlite3` 的那几个测试不能并发执行。环境变量 `NODE_ENV=test`、`FREEZE_CONFIG_FILE=1` 的设置方式要和 Task 3 一致。`bench` 脚本改为用 node 直接执行 `test/benchmark.ts`。

替换对照：`describe/it/before/after/beforeEach/afterEach` 改为从 `node:test` 导入；`expect(...).to.*` 换成 `node:assert/strict` 中的等价断言（`equal`、`deepEqual`、`match`、`throws`/`rejects` 等）；`equalIgnoreCase`、`startsWith` 等 chai-string 断言改成对字符串做处理后再用 `assert` 判断；`this.timeout(n)` 改为 `{ timeout: n }` 选项；`this.skip()` 改为 `t.skip()`。

- [ ] Step 1：转换前先记下 mocha 报告的用例总数 N。
- [ ] Step 2：转换全部测试文件。
- [ ] Step 3：`npm test -w backend` 通过，node:test 报告的用例数 ≥ N，并且没有 skip（原来就 skip 的除外）。
- [ ] Step 4：用 `grep` 确认 `backend` 下已经没有 `@ts-nocheck`，也没有 `chai`/`mocha` 的引用。
- [ ] Step 5：提交 `test: migrate backend tests to node:test`。

### Task 12：应用根目录与 esbuild 打包

**Files:**
- Create：`backend/app-dir.ts`，内容为 `export const appDir: string = import.meta.dirname;`，附一段英文注释说明它在打包后指向哪里
- Modify：`config.ts`（`appDir`）、`app.ts`（`DIST_DIR`）、`routes/metadata.ts`（`static/no-image.jpg`）、`socket.ts`（fork 路径）：全部改为基于 `appDir`
- Create：`backend/scripts/build.ts`、`backend/test/bundle-smoke.ts`
- Modify：`backend/package.json`：加入 `build`、`start:bundle`、`test:bundle` 脚本，把 `esbuild` 加进开发依赖。根 `package.json` 加 `build:backend`，并且 `build` 改为依次构建前端和后端。

**Interfaces:**
- Produces：执行 `npm run build -w backend` 后生成 `backend/build/`，包含：`app.mjs`、`scanner.mjs`、`updater.mjs`、`workFileScanner.mjs`、若干 chunk（都在同一层，不建子目录）、`dist/`（从 `backend/dist` 复制过来，不存在就跳过并打印警告）、`static/`。
- Produces：`socket.ts` 通过 `import.meta.filename.endsWith('.ts')` 判断当前是源码运行还是打包运行。源码运行时 fork `appDir/filesystem/scanner.ts`，打包运行时 fork `appDir/scanner.mjs`（`updater`、`workFileScanner` 同理）。具体判断方式执行者可以自己选，但两种模式都必须有测试覆盖。

esbuild 配置：`bundle: true`、`platform: 'node'`、`format: 'esm'`、`target: 'node26'`、`splitting: true`、`outExtension: { '.js': '.mjs' }`、`entryNames: '[name]'`、`chunkNames: 'chunk-[hash]'`。`external` 包括 knex 不会用到的那些方言驱动（`sqlite3`、`better-sqlite3`、`mysql`、`mysql2`、`pg`、`pg-native`、`pg-query-stream`、`oracledb`、`tedious`、`mariadb/callback`）以及 `serve-index`。用 `banner` 注入 `createRequire`，因为打包进来的 CJS 依赖要用 `require`。另外提供 `--debug` 参数：加上时不压缩并生成 sourcemap，不加时压缩。

- [ ] Step 1：写 `test/bundle-smoke.ts`。它会先执行 `npm run build`，把 `build/` 复制到一个临时目录里（这个目录的上层没有任何 `node_modules`），然后启动 `node app.mjs`。启动时设置 `PORT=随机端口`，**不设置** `KIKO_DATA_DIR`，并带上 `FREEZE_CONFIG_FILE` 以外的必要环境变量。需要断言：
  - 进程能正常启动，`GET /api/health` 返回 200；
  - 临时目录下生成了 `sqlite/db.sqlite3` 和 `config/config.json`，也就是说数据落在产物目录里；
  - `knex_migrations` 中的迁移名都以 `.js` 结尾；
  - 先把配置里的 `basePath` 设为 `/kikoeru` 再重启，此时 `GET /kikoeru/api/health` 返回 200；
  - 如果存在 `dist/index.html`，`GET /kikoeru/` 返回的 HTML 里已经没有 `__KIKO_BASE__`。

  这个测试较慢，所以单独用 `npm run test:bundle` 运行，不放进 `npm test`。
- [ ] Step 2：运行测试，确认失败。
- [ ] Step 3：实现 `appDir` 的接入和 `build.ts`。
- [ ] Step 4：`npm test -w backend` 和 `npm run test:bundle -w backend` 都通过。
- [ ] Step 5：提交 `build: bundle backend into a self-contained build/ directory`。

### Task 13：容器镜像、CI 与 Windows 便携包

**Files:**
- Modify：`Containerfile`、`.containerignore`
- Modify：`.github/workflows/build.yml`、`.github/workflows/build-debug.yml`、`.github/workflows/package-windows.yml`
- Create：`.github/workflows/test.yml`
- Modify：`scripts/package.js`、`scripts/launchers/Kikoenai.bat`、根 `package.json`
- Delete：`scripts/pkg-package.js`，以及 `backend/package.json` 中的 `pkg`、`bin` 字段

**Interfaces：**
- Containerfile 分两个阶段。构建阶段基于 `node:26-alpine`，执行 `npm ci`，然后构建前端和后端（debug 镜像通过 build-arg 切换到调试构建）。运行阶段基于 `node:26-alpine`，安装 `tini` 和 `ffmpeg`，`COPY --from=build /usr/src/kikoeru/backend/build/ ./`。环境变量（`IS_DOCKER`、`NODE_ENV`、`KIKO_DATA_DIR=/appdata`）、工作目录 `/usr/src/kikoeru` 和 `EXPOSE 8888` 都与现在保持一致，`CMD ["node","app.mjs"]`。
- 现在的 workflow 是先在 runner 上构建前端，再用 buildah 构建镜像。改造后两种做法都可以：一是在 runner 上构建前端和后端，Containerfile 只负责复制产物；二是全部放进 Containerfile 里构建。由执行者选一种，但 `build.yml` 和 `build-debug.yml` 必须用同一种做法。所有 workflow 的 `node-version` 改为 26。
- `test.yml`：每次 push 或 PR 时运行，使用 ubuntu 和 Node 26。依次执行 `npm ci`、`npm test -w backend`、`npm run build -w frontend`、`npm run test:bundle -w backend`。
- `scripts/package.js` 可以在任意系统上运行，因为产物里已经没有原生模块。流程是：先 `npm run build`，然后下载 Node 26 的 win-x64 zip（固定一个具体的 v26.x 版本号）和 ffmpeg，组装出如下目录，最后打成 zip。
  ```
  Kikoenai/
    node/node.exe
    app/        (= backend/build/ 的内容)
    ffmpeg/ffmpeg.exe, ffprobe.exe
    Kikoenai.bat
  ```
  打包用 `tar -a -cf` 或任意零依赖的方式都可以，前提是 Linux 上也能跑。`package-windows.yml` 改到 `ubuntu-latest` 上运行，其余逻辑（触发条件、版本号来源、发布 release）不变。
- `Kikoenai.bat` 删掉 exe 分支，改为执行 `"%ROOT%node\node.exe" "%ROOT%app\app.mjs"`，其他内容不动。
- 根 `package.json`：删除 `package:windows:zip`，`package:windows` 指向 `node scripts/package.js`。

- [ ] Step 1：本地执行 `podman build -f Containerfile -t kikoenai-ts .`（没有 podman 就用 docker）。用 `podman run --rm -e KIKO_DATA_DIR=/tmp/d -p 18888:8888 kikoenai-ts` 启动后，`curl localhost:18888/api/health` 应返回 200，并且镜像里没有 `node_modules`（`podman run --rm kikoenai-ts ls`）。如果环境里没有容器工具，在报告里写明，跳过这一步。
- [ ] Step 2：在 Linux 上执行 `node scripts/package.js`，生成的 zip 解压后目录结构要和上面一致。下载步骤可以用环境变量跳过，以便离线验证结构。
- [ ] Step 3：用 `actionlint` 或 `npx yaml-lint` 检查 workflow 的 YAML 语法，至少要能被解析。
- [ ] Step 4：提交 `ci: Node 26 container, test workflow and portable Windows package`。

### Task 14：文档与上游同步约定

**Files:**
- Create：`UPSTREAM.md`
- Modify：`README.md`（Development、Production Build、Structure 这几节）、`AGENTS.md`（root）、`backend/AGENTS.md`（技术栈、目录结构中的 `.js`→`.ts`、命令、测试、§5 中关于 pkg 的过时描述）、`backend/README.md`（如果写了命令）、`scripts/dev.sh`、`scripts/build.sh`

**Interfaces：**
- `UPSTREAM.md` 需要包含：
  - upstream remote 的地址；
  - "Last synced upstream commit: `0d3faa0`"；
  - 文件映射规则；
  - 依赖替换对照表（来自 spec 5.4）；
  - 同步检查清单（来自 spec §6）；
  - 一个同步示例流程：`git log <last>..upstream/main -- backend/` 查看后端改动，`git diff <last> upstream/main -- frontend/` 直接应用前端改动。

- [ ] Step 1：更新文档。所有命令都要能照着跑通，执行者要逐条实际运行文档中出现的 npm 命令。
- [ ] Step 2：确认 `grep -rn "\.js\b" AGENTS.md backend/AGENTS.md` 中剩下的 `.js` 引用都是有意保留的（例如前端文件和 `eslint.config.js`）。
- [ ] Step 3：提交 `docs: document TypeScript layout, build and upstream sync`。
