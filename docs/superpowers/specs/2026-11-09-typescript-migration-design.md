# Kikoenai 后端 TypeScript 化设计

日期：2026-11-09　分支：`ts-migration`（基于 upstream `0d3faa0`）

## 1. 背景与动机

- 本仓库 `Izumiko/Kikoenai` fork 自活跃维护的 `Rivers47/Kikoenai`。原先的 `kikoeru-express`
  / `kikoeru-web` 与其没有共同 git 历史，已放弃，以本 fork 为唯一主线。
- 目标：把 Kikoenai 改造成 TypeScript，并且**持续跟进上游**。上游每月几十个提交，
  因此一切设计都服务于"上游的一个 JS 改动能低成本地移植成对应的 TS 改动"。
- 部署诉求：后端不依赖任何原生二进制模块，尽量使用 Node.js 26 内置能力，
  生产部署只需 `node` + 打包产物，不需要 `node_modules`。

## 2. 目标 / 非目标 / 反目标

目标
1. 后端全部源码、脚本、测试改为 TypeScript（ESM），`tsc --noEmit` strict 通过。
2. 移除原生模块 `sqlite3`，改用内置 `node:sqlite`。
3. 生产产物为 esbuild 打包的少量 `.mjs` 文件 + 前端 `dist/` + `static/`，运行时无 `node_modules`。
4. 行为、REST/Socket.IO 接口、数据库结构、配置文件格式与上游完全一致；
   上游的数据库可以直接拿来用，反之亦然。
5. 与上游文件一一对应，形成可重复的上游同步流程。

非目标（本期不做）
- 前端 TS 化 / 换 Vite / 换 Pinia（单独设计，后续阶段）。
- 架构重组、改用 Drizzle、改 API、改表结构、加新功能。
- Windows 单文件 exe 改造为 Node SEA（后续阶段，见 §9）。

反目标（即使能跑也算失败）
- 文件拆分/合并/改名导致无法和上游逐文件对照。
- 全量重新格式化（如套 Prettier）造成与上游的无意义大 diff。
- 迁移文件名变化导致已有数据库重复执行迁移（见 §5.3）。
- 运行时仍需要 `npm install` 或任何 `.node` 文件。

## 3. 约束

- Node.js `>=26`（engines、Containerfile、CI 一致改为 26）。开发时直接用 node 的
  原生类型剥离运行 `.ts`，不引入 tsx/ts-node。
- 因为原生类型剥离：只允许可擦除语法（无 enum、namespace、参数属性等），
  相对导入写 `.ts` 扩展名。tsconfig：`strict`、`module/moduleResolution: nodenext`、
  `erasableSyntaxOnly`、`verbatimModuleSyntax`、`allowImportingTsExtensions`、
  `rewriteRelativeImportExtensions`、`noEmit`。
- 保持上游代码风格（2 空格、单引号、已有注释原样保留，包括中文注释）。只做 TS 化所需的修改。
  新写的注释用英文（遵循仓库 AGENTS.md）。

## 4. 方案选择（已定）

考虑过三种：
- **A. 按上游结构逐文件 TS 化，数据库继续用 knex（选定）**：与上游一一对应，
  迁移文件原样移植，同步成本最低。
- B. 保留 kikoeru-express 的模块化结构 + Drizzle：架构更干净，但每次同步都要重新映射文件、
  重写 SQL，上游节奏下难以持续。已否决。
- C. 结构一一对应但数据库层换 Drizzle：上游改动最频繁的正是 `queries.js` 和迁移，省不了多少。已否决。

## 5. 设计

### 5.1 文件映射
- `backend/**/X.js` → `backend/**/X.ts`，路径与文件名不变（`test/migration..js` 这种怪名也保留）。
- `backend/package.json` 设 `"type": "module"`。
- 渐进策略（我的决定）：**阶段 0 一次性机械转换**所有后端 `.js` → `.ts`，同时把
  CommonJS 改成 ESM（`require`→`import`，`module.exports`→`export`，相对路径补 `.ts`），
  每个文件顶部暂加 `// @ts-nocheck`，保证转换后立即可运行、测试可跑。之后各阶段逐文件
  去掉 `@ts-nocheck` 并补类型——改动只在单文件内，不牵连别的文件。
  不采用"先改名 `.cjs`"的过渡方案：CJS 的 `require('./x')` 不会解析 `.cjs`/`.ts`，
  反而要把所有导入改两遍。
  函数体内的延迟 `require`（用于打破循环依赖或按需加载）改为顶层 `import` 或
  `await import()`，以不改变加载时副作用为准；`config` 写文件等加载时副作用需逐一核对。
- 例外（保持原样，不转 TS）：`backend/eslint.config.js`（ESLint 加载 TS 配置需 jiti，不值得）、
  根目录 `scripts/*`（发布/打包工具脚本，只做必要修改）、前端全部文件。
- 新增文件仅限：`database/node-sqlite-client.ts`、`database/migrations/index.ts`（迁移清单）、
  类型声明、构建脚本、eslint/tsconfig 配置、`UPSTREAM.md`。

### 5.2 数据库驱动
- 新增 knex 自定义 client：继承 knex 的 `better-sqlite3` dialect，驱动换成 `node:sqlite`
  的 `DatabaseSync`（已做 spike：建表、插入、事务、ALTER/DROP COLUMN、raw 均正常，
  esbuild 打包后在无 node_modules 目录运行正常）。
- `knexfile` 中所有 `client: 'sqlite3'` 换成该 client；`afterCreate` 里的
  `PRAGMA foreign_keys` / `busy_timeout` 改为同步执行。
- 注意差异点需测试覆盖：返回行是 null-prototype 对象、`lastInsertRowid` 可能是 bigint、
  布尔/Date 绑定转换、`stmt.reader` 判定改用 `columns().length`。

### 5.3 迁移
- 迁移文件逐个转 TS，内容不改。
- **knex_migrations 表里记录的是带 `.js` 的文件名**。改用 knex 的自定义 `migrationSource`，
  由 `migrations/index.ts` 静态 import 全部迁移，并以**原 `.js` 文件名**作为迁移名上报。
  这样既兼容已有数据库，又能被 esbuild 打包（不再扫描目录）。
- `knex-migrate` 的 `findMigrationFile` 等逻辑改为基于该清单。
- 上游新增迁移时：新增 `.ts` 文件 + 在清单中登记一行。

### 5.4 依赖处理
原则：能用内置等价替换的替换；纯 JS 且无等价内置的保留（会被打包进产物，不影响"无 node_modules 部署"）。

| 依赖 | 处理 |
|---|---|
| sqlite3 | 移除 → `node:sqlite` |
| dotenv | 移除 → `process.loadEnvFile()`（文件不存在时忽略，保持上游行为） |
| md5 | 移除 → `crypto.createHash('md5')`（**算法不变**，保证旧密码哈希可用） |
| lodash | 移除 → 内置/小函数 |
| url-join | 移除 → 本地 helper，以现有 `test/urljoin` 测试保证行为一致 |
| yargs | 移除 → `util.parseArgs` |
| limit-promise | 移除 → 本地小型并发限制器（接口与用法保持一致） |
| uuid (v5) | 移除 → 基于 `crypto` sha1 的 v5 实现，以固定向量测试保证结果一致 |
| htmlparser2、string-random | 未使用，移除 |
| natural-orderby | 保留（`Intl.Collator` 排序结果与其不完全一致，会改变曲目顺序） |
| undici | 保留（需要 `Agent` 关闭超时，内置 fetch 不暴露 dispatcher） |
| tunnel-agent | 保留（HTTPS 经 HTTP 代理需 CONNECT 隧道，axios 原生 proxy 不支持） |
| express、compression、cookie、cookie-parser、connect-history-api-fallback、express-validator、socket.io、axios、cheerio、jschardet、knex、compare-versions、mime-types | 保留 |
| serve-index（dev only） | 保留为 devDependency，不进生产打包 |

### 5.5 运行与打包
- 开发：`node --watch backend/app.ts`（替代 nodemon）。
- 构建：`backend/scripts/build.ts` 用 esbuild 打包，入口：`app.ts`、`filesystem/scanner.ts`、
  `filesystem/updater.ts`、`filesystem/workFileScanner.ts` 及 `package.json` 中的 CLI 脚本；
  输出到 `backend/build/*.mjs`，ESM，knex 其他方言驱动标为 external（永不加载）。
- `socket.js` 中 `child_process.fork` 的脚本路径改为同时适配源码（`.ts`）和打包产物（`.mjs`）。
- 应用根目录（我的决定）：新增 `backend/app-dir.ts` 导出 `appDir = import.meta.dirname`。
  源码运行时它是 `backend/`；打包时该模块被内联进 `build/` 下的 chunk，因此是 `build/`。
  打包输出**扁平**（入口与 chunk 同在 `build/`，不分子目录），所以两种运行方式下
  `appDir` 都是"包含 `dist/`、`static/` 的部署目录"。所有 `__dirname` 依赖
  （`config.appDir`、`DIST_DIR`、`static/no-image.jpg`、fork 子进程脚本路径）改用它。
- 构建产物是一个自包含目录 `backend/build/`：`*.mjs` + 复制进去的 `dist/` + `static/`。
  这个目录就是完整部署单元；未设置 `KIKO_DATA_DIR` 时数据默认落在该目录（与上游
  "数据在应用目录"的语义一致）。容器和 Windows 启动脚本都显式设置 `KIKO_DATA_DIR`，不受影响。
- `npm start` 保持运行源码（`node app.ts`，与上游"start 跑源码"一致，数据目录不变）；
  新增 `npm run build:backend` 与 `npm run start:bundle`（`node build/app.mjs`）。
- `scraper/tag-aliases.json`、`va-aliases.json` 改为 `import ... with { type: 'json' }`，
  打包时内联，不再运行时读文件。
- 版本号：`package.json` 同样以 JSON import 读取（打包时内联）。
- Containerfile：`node:26-alpine`；构建阶段 `npm ci` + 构建前端 + 打包后端；
  运行阶段只复制 `build/` 目录，保留 tini、ffmpeg，`CMD ["node","app.mjs"]`。
  build.yml / build-debug.yml 同步改（debug 版产物不压缩、带 sourcemap）。
- Windows（已与用户确认）：放弃 `@yao-pkg/pkg` 单文件 exe，改为**便携 zip**：
  官方 Node 26 win-x64 `node.exe` + `app/`（即 `build/` 目录）+ ffmpeg/ffprobe + `Kikoenai.bat`，
  无 node_modules，因此**不再需要在 Windows 主机上构建**（可在 ubuntu runner 打包）。
  改写 `scripts/package.js`，删除 `scripts/pkg-package.js` 及 backend `package.json` 的 `pkg` 段，
  `Kikoenai.bat` 改为启动 `app\app.mjs` 并去掉 exe 分支，`package-windows.yml` 相应调整。
  Node SEA 单 exe 留到后续阶段。
- ffmpeg/ffprobe 仍为外部可执行程序（不是 node 模块），行为不变。

### 5.6 测试与检查
- mocha + chai → 内置 `node:test` + `node:assert`（零依赖、直接跑 `.ts`）。
  测试随对应源码一起转换；断言语义一一对应，不删减用例。
- 基线：当前上游 `mocha` 280 通过、1 失败（`scan-logging` 用了 Node 26 已移除的
  `rmdirSync({recursive})`，属上游在 Node 26 下的问题，迁移时顺手修为 `rmSync`）。
- 新增测试：node-sqlite client、迁移名兼容（用 upstream 版本建的库升级后不重复执行）、
  uuid v5 向量、md5 哈希兼容、打包产物冒烟（无 node_modules 目录下启动并访问 `/api/version` 等）。
- ESLint flat config + typescript-eslint，规则以上游现有 eslint 配置为基础，不引入格式化规则。
- 根脚本：`npm run typecheck`、`npm test`（lint + typecheck + node:test）。
- node:test 以 `--test-concurrency=1` 串行运行（多个测试共用 `test/db-test.sqlite3`）。
- CI（我的决定）：新增 `test.yml`，每次 push/PR 在 Node 26 上跑 lint、typecheck、
  测试、后端打包，以及在无 node_modules 的临时目录启动打包产物的冒烟测试。

### 5.7 前端在本期的最小改动
- 仅改 `quasar.config.js` 对 `../backend/base-path` 的引用（指向 `.ts`；Node 26 下 CJS 可
  `require()` ESM `.ts`，已验证）以及 engines；需验证 `quasar build` 实际可用。其余前端不动，构建产物仍输出到 `backend/dist/`。

## 6. 上游同步流程
- 添加 `upstream` remote 指向 `Rivers47/Kikoenai`。
- `UPSTREAM.md` 记录"已同步到的上游 commit"和映射规则（`X.js` ↔ `X.ts`、迁移清单、被替换依赖的对应位置）。
- 同步方式：`git log <last>..upstream/main`，前端改动直接 cherry-pick/merge；
  后端改动按文件对照手工移植为 TS。迁移期间（尚未完成时）上游的后端改动先积压，
  完成后统一追平，再进入常态同步。
- 同步检查清单需包含：新增迁移要登记到清单；新增依赖要先判断能否用内置功能替换；
  新增运行时读取的数据文件要改为 import 内联或加入构建复制；新增 `require` 要改写为 `import`。

## 7. 分阶段（按依赖从叶到根，每阶段后全部测试通过、服务可启动）
0. 基础设施：remote、Node 26、tsconfig、eslint；node-sqlite client 替换 sqlite3；
   全量机械转换为 ESM `.ts`（带 `@ts-nocheck`），现有 mocha 测试在 `.ts` 下全部通过。
1. 无依赖的工具模块（`base-path`、`work-id`、`routes/utils/*`、`auth/utils` 等）。
2. `config`、`database/*`、迁移与迁移清单。
3. `scraper/*`。
4. `filesystem/*`、`asr`、`track-titles`、`transcribe-work` 等。
5. `auth/session`、`routes/*`。
6. `app`、`socket`、`upgrade`。
7. `backend/scripts/*`；测试从 mocha 全部换到 node:test，移除 mocha/chai。
8. 打包、Containerfile、Windows 便携包、CI、文档（README/AGENTS.md 中的命令与结构）。

## 8. 留给实施者自行决定
- 类型的组织方式（就地声明为主，跨文件共享的放 `types/`）。
- 各阶段内部的提交粒度。
- 测试从 mocha 到 node:test 的过渡时机（可在阶段 1–6 随源码转换，也可集中在阶段 7）。
- 上游自身已存在的 AGENTS.md 中的矛盾（如 §5 说 pkg 已移除）在阶段 8 一并修正。

## 9. 后续阶段（不在本设计范围）
- 前端 TS 化（建议跟随上游的 Pinia 迁移节奏）。
- Windows 便携 zip 升级为 Node 内置 SEA 单文件 exe。
