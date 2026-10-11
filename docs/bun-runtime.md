# Bun 运行时迁移：recon 与 spike 实测

> 目标：评估把 peri-fuse 的运行时从 Node.js 迁移到 Bun 的可行性，产出**文件级改动清单**与**实测证据**。
>
> 本文所有结论均来自本机实跑，未采用推测。所有 spike 均在隔离环境（`PERIFUSE_HOME=/tmp/bun-spike/*`、独立端口）中执行，未改动任何项目源文件，未触碰 `~/.peri-fuse` 中的真实数据。

## 迁移实施状态（已落地）

> 本节记录迁移执行后的最终形态与执行期修正；§1–§8 保留 recon/spike 的原始证据与建议，供追溯。

### 最终形态

| 面 | 最终形态 |
| --- | --- |
| server 启动 | `packages/server`：`start` = `bun dist/index.js`，`dev` = `bun --watch --preload ./src/env.ts src/index.ts`，`test:e2e` = `bun e2e/run.mjs` |
| gateway 启动 | `packages/gateway`：`start` = `bun dist/index.js`，`dev` = `bun --watch src/index.ts`（实测可直接启动，无需 preload） |
| CLI | `test` = `bun test test/`，`dev` = `bun src/index.ts`；daemon 继续用 `process.execPath`（Bun 下即 bun 自身） |
| 服务脚本 | 根 `svc`/`svc:start`/`svc:stop`/`svc:status`/`svc:logs` = `bun packages/cli/dist/index.js …`（不再经 Node bin shim，daemon 因此也在 Bun 下） |
| MCP | `packages/langfuse-mcp`：`start` / `start:stdio` / `start:http` = `bun dist/cli.js` |
| e2e runner | `packages/server/e2e/run.mjs` 的 4 处 `spawn("node", …)` 改为 `spawn(process.execPath, …)` |
| Docker | 新增 `FROM oven/bun:1.4.2-debian AS bun` 作为二进制来源；runtime 仍基于 `node:22-bookworm-slim` 并拷入 Bun，`CMD`/`HEALTHCHECK` 改用 `bun` |
| engines | 根、shared、server、gateway、cli、langfuse-mcp：`{ "bun": ">=1.4.2", "node": ">=22.12.0" }`（`web` 仅构建期，未改） |
| 工具链（保持 Node） | `tsc`/`esbuild`/`biome`/`vite`/`vitest`、`packages/cli/build.mjs`、`scripts/release.mjs`、`scripts/test-ingestion-isolated.mjs`、root `dev` 的 `concurrently` |
| 不变量 | 单文件 ≤ 500 行；未改 `packages/shared/src/**`（另一工作流负责）；`turbo.json` 无需改动 |

### 执行期修正（本文建议 → 实际落地）

1. **HEALTHCHECK 必须 `await`（重要）**：Bun 的事件循环一旦无活跃 await 即退出，`fetch(...).then(...)` 形式实测 **exit 0**（不等待、不校验），健康检查会形同虚设。最终写法为顶层 `await fetch(...)`（`require` + TLA 在 `bun -e` 中可用），并在 `packages/server/src/container-port-config.test.ts` 中新增 `await fetch(` 断言防止回退。
2. **Docker 采用 §6.2 的方案二**（保留 Node 基础镜像 + 拷贝 Bun 二进制）。原因：阻塞项 1 的方案 A 要求镜像内保留**真 Node**（`oven/bun:*-debian` 内的 `node` 只是指向 bun 的 `bun-node-fallback-bin/node` shim，不能跑 `node:sqlite`）；同时 deps/build/production-deps 阶段仍需 pnpm + corepack。实测 Bun 二进制在 `node:22-bookworm-slim`（Debian 12）中可直接运行。
3. **`packages/cli/build.mjs`、`packages/langfuse-mcp/build.mjs` 仍由 Node 执行**：`npx tsc` 改为直接调用包内 `node_modules/typescript/bin/tsc`（用 `process.execPath`，去掉 npx 解析/网络依赖），但脚本本身不切 Bun —— `.github/workflows/npm-publish.yml` 只安装 Node + pnpm，切到 Bun 会中断发布（该 workflow 不在本次改动范围）。符合「构建工具链可继续用 Node」的决策。
4. **root `test:ingestion`、`release` 保留 `node`**：前者以 `process.execPath` 拉起 Vitest，Bun 下会命中 §4.2 的 pool 差异；后者是发布工具，与产品运行时无关。
5. **`packages/cli/package.json` 的 `tsx` devDependency 保留**：`dev`/`test` 已不再使用 tsx，但删除需同时刷新 `pnpm-lock.yaml`（`--frozen-lockfile` 会失败），留待下次依赖整理。
6. **server 的 `dev` 必须带 `--preload ./src/env.ts`（重要）**：Bun 直接运行 TS 源码时会提升 import 求值，`src/index.ts` 中「`./env` 必须是第一个 import」的约定失效 —— 实测裸 `bun --watch src/index.ts` 下 `@peri-fuse/shared` 的 env schema 先于 `dotenv`/lite 模式生效，报 `CLICKHOUSE_URL` 等必填错误（同一命令用 `tsx watch` 正常）。加 `--preload` 后恢复该顺序，实测 `mode=lite`、健康端点 200。构建产物（`bun dist/index.js`）不受影响：tsc 输出为 CJS，`require("./env")` 顺序天然保留。

### 已知限制（不修复，明确记录）

1. **Vitest 不在 Bun 下运行**：`pool: forks`（仓库默认）与 `threads` 在 Bun 下会导致 `zod` 命名导出解构为 `undefined`；`vmThreads` 可跑通但隔离语义不同（§4.2/§4.3）。因此 Vitest 固定走 Node 轨。
2. **`otel` 两个测试文件在 Bun + Vitest 下无法加载**：`TypeError: The property 'exportNames.default' is duplicated`（§4.3a），仅影响「Bun 跑 Vitest」这一未采用路径。
3. **`scripts/migrate-legacy-db.sh` 必须用 `NODE_BINARY=node`**：Turso + `node:sqlite` 混用在 Bun 下会触发 `Locking error`（§5 阻塞项 1）。脚本已有 `NODE_BINARY` 间接层，Docker 镜像内 `ENV NODE_BINARY=node` 保持真 Node 可用。
4. **`process.execPath` 语义**：CLI 由 Bun 启动时 daemon 必然也是 Bun；`bun packages/cli/dist/index.js` 与 `node packages/cli/dist/index.js` 都能跑（产物是 CJS），但只有前者符合本次的运行时基线。

### 未在本次执行

- `docs/embedded-turso.md` 第 8–9 行仍写着「Node.js 22.12.0 或 newer is required because … require-ESM support」，该理由在 Bun 下已不成立；此文件不在本次允许修改的范围内，建议后续改为「Bun >= 1.4.2 运行时（Node 22.12+ 仍用于工具链）」。`docs/legacy-db-migration.md` 第 3 行的 `NODE_BINARY=node` 说明在本次改动后依然准确。
- `.github/workflows/*` 未改动：Dockerfile 变更自包含（`oven/bun` 基镜像按目标平台拉取），`npm-publish.yml` 的构建链仍是 Node。
- 发布策略（§7.7 / §9）：`peri-fuse` 仍以 CJS 产物发布，`engines` 同时声明 `bun` 与 `node`，bin shebang 未改，避免在发布策略定案前提高 npm 用户门槛。

---

## 0. 结论速览

| Spike | 结论 | 判定 |
| --- | --- | --- |
| 1. 构建 + Bun 启动 server | shared/gateway/server 以 `tsc` 构建通过；Bun 启动 server，迁移、bootstrap、HTTP、ingestion 写入与回读、SPA 静态资源、SIGTERM 优雅退出全部正常 | **通过** |
| 2. CLI 在 Bun 下 | `start`/`status`/`stop` 全链路正常；daemon 经 `process.execPath` 正确拉起 `bun … dist/server.cjs`，pid/端口/日志/状态文件自洽 | **通过** |
| 3. 测试体系 | vitest 可在 Bun 下运行，但仓库默认 `pool: forks` 下部分文件加载失败；改用 `pool: vmThreads` 后 shared 264/270 通过（Node 基线 298/298）；`bun test` 可原生跑 CLI 的 node:test 套件 12/12 | **部分通过** |
| 4. 依赖嗅探 | `winston`、`@hono/node-server`、`@tursodatabase/serverless`、`@opentelemetry/sdk-trace-base` 四项全部可用 | **通过** |

**总体判断**：运行时主体（HTTP 承载、原生 DB 驱动、日志、鉴权、ingestion）在 Bun 下可用，迁移可行。但存在 **1 个确定性阻塞项**（Turso `multiprocess_wal` 与 Bun `node:sqlite` 的交互，阻断 `migrate-legacy-db.sh`）与 **1 类测试框架层差异**（vitest fork/threads pool），需要作为前置工作解决。

---

## 1. 环境与方法

```
Bun        1.4.2        /Users/konghayao/.bun/bin/bun
Node       v26.9.0      /Users/konghayao/.local/bin/node   （本机基线）
pnpm       10.14.0
平台        macOS 26.5.1 / arm64 (Apple Silicon)
git         main @ 4d96d96，工作区干净
```

需要留意的基线差异：仓库 `engines` 要求 `node >= 22.12.0`，Dockerfile 固定 `node:22-bookworm-slim`，而**本机 Node 为 v26.9.0**。第 3 节的 Node 基线是在 v26.9.0 上取得的，与 CI/Docker 的 Node 22 可能存在细微差别（见 §6 未验证面）。

构建产物仅生成 `dist/`，未修改 `package.json`、脚本或配置。

---

## 2. Spike 1：构建 + Bun 启动 server —— 通过

### 2.1 构建

```bash
pnpm --filter @peri-fuse/shared run build \
  && pnpm --filter @peri/gateway run build \
  && pnpm --filter @peri-fuse/server run build
# EXIT=0
```

三个包均以 `tsc` 编译成功（`module: NodeNext`，无 `"type": "module"`，产物为 CommonJS）。

### 2.2 启动

```bash
cd /tmp/bun-spike
PERIFUSE_HOME=/tmp/bun-spike/home LITE_SERVER_PORT=23999 LANGFUSE_MODE=lite SALT=<throwaway> \
  bun /Users/konghayao/code/ai/langfuse-lite/packages/server/dist/index.js
```

> 从 `/tmp` 启动以避开仓库根 `.env`（`packages/server/src/env.ts` 会从 cwd 向上查找 `.env`）。

启动日志关键片段：

```
[lite-server] Serving lite-web SPA from .../packages/web/dist
[gateway-init] Gateway schema ready.
[bootstrap] No API keys found — creating default organization and project…
║  Public Key:  pk-lf-0249850b-…  ║  Secret Key:  sk-lf-f284564d-…
[lite-server] Peri-Fuse server listening on http://localhost:23999 (mode=lite)
```

即：Drizzle 迁移、gateway schema 初始化、首启 bootstrap（org/project/API key 写入）全部完成。

### 2.3 端点与真实 API 调用

| 调用 | 结果 |
| --- | --- |
| `GET /api/public/health` | `200` `{"status":"OK","version":"4.10.0"}` |
| `GET /api/public/ready` | `200` `{"status":"OK"}` |
| `GET /api/public/projects`（Basic 鉴权） | `404` — Lite 未实现该路由，**非 Bun 问题** |
| `POST /api/public/ingestion`（SDK 兼容批格式） | `207` `{"successes":[{"id":"spike-ev-1","status":201}],"errors":[]}` |
| `GET /api/public/traces?limit=5` | `200`，回读到 `bun-spike-trace-1`，`metadata.runtime="bun-1.4.2"` |
| `GET /api/public/traces/bun-spike-trace-1` | `200`，字段完整 |
| `GET /`（`Accept: text/html`） | `200` `text/html` 1022 bytes |
| `GET /assets/<file>.js` | `200` `text/javascript` |
| `GET /dashboard`（`Accept: text/html`） | `200` `text/html` |

写入 → Turso 原生驱动落盘 → 回读闭环成立。隔离目录内正确生成了 `-tshm` / `-wal` 伴生文件：

```
langfuse.turso.db  langfuse.turso.db-tshm  langfuse.turso.db-wal
telemetry.turso.db  …-tshm  …-wal
gateway.turso.db    …-tshm  …-wal
```

> 注意：`GET /` 不带 `Accept: text/html` 时返回 `404`，这是 `packages/server/src/spa.ts` 的**既有设计**（`acceptsHtml()` 门禁），与运行时无关。

### 2.4 日志洁净度与退出

- 全日志扫描 `error|fail|unhandled|warn|reject`：**零命中**（已排除预期的 "No API keys found" 首启提示）。
- `SIGTERM` → 进程在 1 秒内退出，端口释放，`lsof` 无残留监听。`src/index.ts` 的 `shutdown()` 优雅关闭路径在 Bun 下工作正常。

---

## 3. Spike 2：CLI 在 Bun 下 —— 通过

```
$ bun packages/cli/dist/index.js start
ℹ Starting server (pid 84438, port 23432)…
✔ Server is up at http://localhost:23432

$ bun packages/cli/dist/index.js status
✔ Server is running.
  pid: 84438   port: 23432   uptime: 14s   health: ok

$ bun packages/cli/dist/index.js stop
ℹ Stopping server…
✔ Server stopped.        # 状态文件已清除，端口已释放，无残留进程
```

**daemon 进程实测**（`packages/cli/src/lib/daemon.ts:88` 的 `spawn(process.execPath, [entry])`）：

```
84438  1  /Users/konghayao/.bun/bin/bun .../packages/cli/dist/server.cjs
```

三点关键结论：

1. `process.execPath` 在 Bun 下返回 **bun 自身路径**，因此现有 spawn 逻辑无需改写即可拉起子进程。
2. Bun 能直接运行 CLI 的 **CJS bundle**（`dist/server.cjs`，esbuild `format: "cjs"`）。
3. `ppid=1` 表明 `detached: true` + `child.unref()` 在 Bun 下正确脱离；`process.kill(pid, 0/SIGTERM/SIGKILL)` 探测与升级路径（`isAlive` / `stopServer`）均按预期工作。

**踩坑记录（重要）**：`daemon.ts:83` 的 `mergedEnv = { ...process.env, ...dotenvEnv }` 让 **`.env` 覆盖 `process.env`**。因此在仓库内运行时 `LITE_SERVER_PORT` 来自根 `.env`（`23432`），命令行传入的同名变量会被忽略。迁移评审与测试脚本需注意此语义。

---

## 4. Spike 3：测试体系 —— 部分通过

### 4.1 运行方式

仓库 `package.json` 用 `vitest run`。Bun 下**不能**直接执行 `.bin/vitest`——它是 shell 包装脚本，Bun 会当作 JS 解析并报语法错：

```
error: Expected ")" but found ""$(echo ""
    at .../node_modules/.bin/vitest:2:19
```

可用的入口是直接指向 JS：

```bash
bun ./node_modules/vitest/vitest.mjs run <files>
```

### 4.2 pool 差异（框架层）

| pool | Bun 结果 |
| --- | --- |
| `forks`（仓库默认） | ❌ 部分文件加载失败：`TypeError: undefined is not an object (evaluating 'z.coerce')` @ `src/env.ts:8` |
| `threads` | ❌ 同上 |
| `vmThreads` | ✅ 通过 |

已排除"zod 本身不兼容"：在 Bun 与 Node 下 `import { z } from "zod"` 均正常（`z.coerce` 为 object，导出键完全一致）。问题出在 vitest 的 fork/threads worker 内 Bun 的 ESM⇄CJS 互操作，导致 `zod` 的命名导出解构为 `undefined`。

### 4.3 shared 全量套件对比

| 运行时 | 测试文件 | 收集用例 | 通过 | 失败 |
| --- | --- | --- | --- | --- |
| Node（默认 `forks`） | 36 | 298 | **298** | 0 |
| Bun（`--pool=vmThreads`） | 36 | 270 | **264** | 6 |

Bun 少收集 28 个用例，原因是 2 个文件在 import 阶段整体失败。

**失败分类：**

**(a) 框架层 —— Bun ESM/CJS 互操作（2 个文件，28 个用例未收集）**

```
src/server/otel/OtelIngestionProcessor.metadataDropped.test.ts
src/server/otel/OtelIngestionProcessor.lite.test.ts
TypeError: The property 'exportNames.default' is duplicated. Received 'default'
```

vite-node 在 Bun 下加载同时具有 `default` 与命名导出的 CJS 模块时冲突，整个文件无法加载。

**(b) 运行时层 —— Turso 锁（4 个用例）**

```
src/db/legacy-migration.test.ts  （4 个失败）
Migration failed: failed to open database …/.langfuse.turso.db.migrating:
Locking error: … Database is already open without experimental multiprocess WAL
in another process
```

已在 vitest 之外独立复现，**判定为 Bun 运行时问题**，详见 §5 阻塞项。

**(c) 断言层 —— 错误信息差异（1 个用例）**

```
src/db/remote.test.ts
AssertionError: expected [Function] to throw error including 'FOREIGN KEY'
                 but got 'SQL failure'
```

`packages/shared/src/db/__tests__/remote-test-server.ts:114` 的 mock 在 `error` 非 `Error` 实例时回退为字符串 `"SQL failure"`。属于错误对象形态/类别的差异，**不是逻辑错误**，可通过放宽断言或对齐错误类型解决。

### 4.4 CLI 包：`bun test` 原生可用

CLI 用的是 `node:test`（`tsx --test test/*.test.ts`）。Bun 原生 runner 直接跑通：

```
$ cd packages/cli && bun test test/
(pass) CLI lifecycle commands > …
 12 pass
 0 fail
Ran 12 tests across 1 file. [22.00ms]
```

这对 CLI 包是一条干净的迁移路径：`tsx --test` → `bun test`。

---

## 5. 阻塞项

### 阻塞项 1（确定性）：Turso `multiprocess_wal` 与 Bun `node:sqlite` 交互，阻断 legacy 迁移

**影响面**：`scripts/migrate-legacy-db.sh` → `scripts/legacy-migration/cli.mjs` → `target.mjs:completeTarget()`。即文档中"从 SQLite 迁移到嵌入式 Turso"的唯一入口。

**最小复现**（无需 vitest，脚本位于 `/tmp`，通过绝对路径加载驱动）：

1. Turso 驱动以 `experimental: ["multiprocess_wal"]` 打开 DB，建表，`close()`
2. `node:sqlite` 的 `DatabaseSync` 以 `{ readOnly: true }` 打开同一文件，执行 `PRAGMA quick_check`，`close()`
3. Turso 驱动再次以 `multiprocess_wal` 打开同一文件

| 运行时 | 结果 |
| --- | --- |
| Node v26.9.0 | ✅ OK |
| Bun 1.4.2 | ❌ `Locking error: … already open without experimental multiprocess WAL in another process` |

**端到端佐证**（同一条命令、同一份 fixture，仅切换 `NODE_BINARY`）：

```
$ NODE_BINARY=bun bash scripts/migrate-legacy-db.sh --source-dir … --target-dir … --offline
[metadata] organizations: copied 1 rows
[metadata] organizations: verified 1 rows (SHA-256)
…（4 张表全部复制并校验通过）
[metadata] checking SQLite integrity and foreign keys independently
Migration failed: … Locking error …          # ← 仅最后一步失败
MIG_EXIT=1

$ NODE_BINARY=node bash scripts/migrate-legacy-db.sh --source-dir … --target-dir … --offline
[metadata] checking SQLite integrity and foreign keys independently
[metadata] ready: …/langfuse.turso.db
Migration complete.                          # ← 完整成功
NODE_EXIT=0
```

**机制定位**：步骤 2 后 Bun 会**遗留 `-shm` 文件**（Node 不遗留）：

```
after Turso close:       h3.db, h3.db-tshm, h3.db-wal
after node:sqlite close: h3.db, h3.db-shm, h3.db-tshm, h3.db-wal   # Bun
                         h3.db, h3.db-tshm, h3.db-wal              # Node
```

手工删除 `-shm`/`-tshm` **无法**恢复（说明 Bun 侧还保留了进程内原生状态，不只是文件残留）。故 Trigger 是：*Turso 打开 → Bun 的 `node:sqlite` 打开/关闭同一文件 → Turso 再打开*。

> 注意：跨进程 `multiprocess_wal` 共享本身在 Bun 下**正常工作**（Bun 父进程 + Bun 子进程同时打开同一 DB，成功；与 Node 行为一致）。问题只出现在与 `node:sqlite` 混用之后。

**最小改动建议（本次未实施）**，按推荐度排序：

- **A｜保留 Node 跑迁移脚本（推荐）**：`scripts/migrate-legacy-db.sh` 本就有 `NODE_BINARY` 间接层，**无需改代码**，只需在 Bun 运行时下显式设 `NODE_BINARY=node`。迁移是一次性离线工具，保留 Node 依赖成本最低。
- **B｜把独立校验放进子进程**：`completeTarget()` 里用 `node:sqlite` 做 `quick_check`/`foreign_key_check` 的那几行改为 spawn 一个独立子进程执行，让 Bun 的 SQLite 状态随进程退出彻底释放。
- **C｜放弃"独立实现"校验**：直接用 Turso 连接执行 `PRAGMA quick_check` / `foreign_key_check`。改动最小，但会失去"用另一种 SQLite 实现独立验证"的原有安全属性。

### 阻塞项 2（框架层，可绕过）：vitest 默认 pool 在 Bun 下不可用

仓库 `packages/shared/vitest.config.ts` 固定 `pool: "forks"`，该 pool 与 `threads` 在 Bun 下都会导致部分文件加载失败（§4.2）。`vmThreads` 可用，但切换 pool 会改变隔离模型（vmThreads 在单进程内以 VM 上下文隔离，而非独立进程），可能影响依赖真实进程隔离的用例（如 `sqlite-read-pool`、`legacy-migration`）。**建议**：不要全局切换 pool，而是为 Bun 维护一份覆盖配置（`--pool=vmThreads` 或独立 config 文件），并逐文件核对隔离语义。

### 阻塞项 3（框架层）：CJS/ESM 导出冲突

`exportNames.default is duplicated` 阻断 `packages/server/src/otel/*` 两个测试文件（28 个用例）。需要在 Bun 下定位具体是哪个被 externalize 的依赖触发，再决定是调整 `server.deps.inline` 还是回避该导入形态。

---

## 6. 文件级改动清单

### 6.1 运行时版本声明与文档

| 路径 | 现状 | 改法 |
| --- | --- | --- |
| `package.json`（根）:7-9 | `engines.node >= 22.12.0` | 保留 Node 作为兼容下限，新增 `"bun": ">=1.4.2"`，或按迁移策略改写为说明性字段 |
| `packages/shared/package.json`:11-13 | `engines.node >= 22.12.0` | 同上 |
| `packages/server/package.json`:7-9 | 同上 | 同上 |
| `packages/gateway/package.json`:9-11 | 同上 | 同上 |
| `packages/web/package.json`:9-11 | `engines.node >= 22` | 同上（web 仅构建期，优先级低） |
| `packages/cli/package.json`:7-9 | 同上 | **需要重点评估**：这是发不到 npm 的包，`engines` 直接影响 `npx peri-fuse` 的用户门槛 |
| `README.md`:8 | "Requires Node.js 22.12.0 or newer." | 改为 Bun 优先、Node 兼容的表述 |
| `README.md`:52 | "Source development requires Node.js 22.12.0 or newer and pnpm 10" | 同上，补充 `bun` 版本 |
| `CLAUDE.md`:23 | "Node.js >= 22.12.0" | 同步 |
| `AGENTS.md`:9 | "Node.js >= 22.12.0, pnpm monorepo" | 同步 |
| `docs/embedded-turso.md`:8-9 | 解释"Node 22.12+ 因 CJS server/CLI 通过 require-ESM 加载驱动" | **需改写**：该理由在 Bun 下不成立，需给出新的驱动加载说明 |
| `docs/legacy-db-migration.md`:3 | "Docker 镜像通过 `NODE_BINARY=node` 运行迁移工具" | 若采纳阻塞项 1 的方案 A，此处改为显式说明"迁移脚本保留 Node" |

### 6.2 Docker

| 路径 | 现状 | 改法 |
| --- | --- | --- |
| `Dockerfile`:6,48 | `FROM node:22-bookworm-slim`（base / runtime 两级） | 方案一：改用 `oven/bun:1.4.2-debian`（或 `-slim`）作为 base/runtime；方案二：保留 Node 基础镜像，在多阶段构建中从 `oven/bun` 拷贝二进制（`COPY --from=oven/bun:1.4.2 /usr/local/bin/bun /usr/local/bin/bun`）。**注意**：Turso 原生绑定是 per-platform 预编译产物，多架构（amd64/arm64）需分别验证 |
| `Dockerfile`:52 | `ENV NODE_BINARY=node` | 若阻塞项 1 走方案 A，**保持 `node`**；若彻底去 Node，需让迁移脚本支持 Bun 并验证通过 |
| `Dockerfile`:74 | `HEALTHCHECK … CMD ["node","-e","const { resolveLiteServerPort } = require('./packages/server/dist/port.js'); …"]` | 改为 `bun -e`，或改为不依赖运行时的 `curl`/`wget`。**必须同步改测试**（见下） |
| `Dockerfile`:76 | `CMD ["node","packages/server/dist/index.js"]` | 改为 `CMD ["bun","packages/server/dist/index.js"]` |

**Dockerfile 有测试强耦合，改 Dockerfile 必须同步改测试：**

- `packages/server/src/docker-build-config.test.ts`:50-63 —— 断言 `node:22-bookworm-slim AS runtime`、`CMD ["node", "packages/server/dist/index.js"]`、`NODE_BINARY=node`、且 runtime 阶段不含 `pnpm`/`corepack`。
- `packages/server/src/container-port-config.test.ts`:145 —— 断言 HEALTHCHECK 命令前两项为 `["node", "e"]`。

### 6.3 脚本与构建

| 路径 | 现状 | 改法 |
| --- | --- | --- |
| `dev.sh`（单行） | `LITE_SERVER_PORT=23432 pnpm --filter @peri-fuse/server run dev` | 保持 shell 不变；内部 `dev` 脚本由 `tsx watch` 改 `bun --watch`（见 6.4） |
| `turbo.json` | 仅任务图（`build`/`typecheck`/`test`/`dev`） | **无需改动**。注意 turbo 本身是 Node 二进制，`pnpm run build` 编排仍走 Node；若要完全脱离 Node，需另建 `bun run` 编排或直接调用各包脚本 |
| `scripts/release.mjs` | 仅用 `execFileSync` 调 git；`#!/usr/bin/env node` | 运行时无关，`bun scripts/release.mjs` 可直接跑。可选：改 shebang 或保留 |
| `scripts/migrate-legacy-db.sh`:5,11,16 | `NODE_BINARY="${NODE_BINARY:-node}"`；`--experimental-sqlite` 探测；`exec "$NODE_BINARY" …` | **阻塞项 1 的核心**。方案 A：默认仍为 `node`（无需改）。方案 B/C：需改 `scripts/legacy-migration/target.mjs:163-176` 的 `completeTarget()` |
| `scripts/test-ingestion-isolated.mjs`:41,52 | 使用 `process.execPath` | 运行时无关；Bun 下会以 bun 拉起 tsc。需实测确认 |
| `scripts/perf-trace-bench.mjs`、`prune-telemetry.mjs`、`seed.mjs`、`session-search-benchmark.mjs` | 未逐一审计 | 列为待办：逐个确认是否有 `node:` 专属 API |
| `packages/cli/build.mjs`:19 | `execFileSync("npx", ["tsc"], …)` | 改 `execFileSync("bun", ["x", "tsc"], …)` 或直接调用 `node_modules/typescript/bin/tsc`（**推荐后者**，去掉 npx 网络依赖） |
| `packages/cli/build.mjs`:23-34,43-62 | esbuild `platform: "node"`, `target: "node22"`, `format: "cjs"`, `external: ["@tursodatabase/database","@tursodatabase/database-common"]` | **external 处理是正确的**：原生 `.node` 绑定不可 bundle，必须保持 external。Bun 能加载该 CJS bundle（Spike 2 已验证），故 `platform`/`target` 可保留；若要 Bun 原生产物可另加一条 `target: "bun"` 构建，但**不建议**移除 external |
| `packages/server/e2e/run.mjs`:23,91,106,121 | 硬编码 `spawn("node", ["dist/index.js"])` | **必改**：改为 `spawn(process.execPath, …)` 或可配置的运行时变量，否则 e2e 永远跑在 Node 上 |
| `packages/langfuse-mcp/package.json` | 已含 `@types/bun` devDep，且已提交 `bun.lock` | 该包看起来已按 Bun 准备；其 `build.mjs`（`node build.mjs`）与测试需单独验证 |

### 6.4 各包 `package.json` scripts（`node` / `tsx` → `bun`）

| 包 | script | 现状 | 改法 |
| --- | --- | --- | --- |
| `packages/server` | `start` | `node dist/index.js` | `bun dist/index.js` |
| `packages/server` | `dev` | `tsx watch --clear-screen=false --ignore '../web/**' --ignore '../../node_modules/.vite/**' src/index.ts` | `bun --watch src/index.ts`（**注意**：Bun 无 `--ignore`，需改用 `bun --watch` + `--hot` 语义，或保留 tsx 作为 dev 兜底） |
| `packages/server` | `test:e2e` / `test:e2e:evals` | `node e2e/run.mjs` | `bun e2e/run.mjs`（并修 e2e 内部的硬编码 `node`） |
| `packages/gateway` | `start` | `node dist/index.js` | `bun dist/index.js` |
| `packages/gateway` | `dev` | `tsx watch --clear-screen=false src/index.ts` | `bun --watch src/index.ts` |
| `packages/cli` | `build` / `prepublishOnly` | `node build.mjs` | `bun build.mjs` |
| `packages/cli` | `dev` | `tsx src/index.ts` | `bun src/index.ts` |
| `packages/cli` | `test` | `tsx --test test/*.test.ts` | `bun test test/`（已验证 12/12 通过） |
| `packages/langfuse-mcp` | `start` / `start:stdio` / `start:http` | `node dist/cli.js` | `bun dist/cli.js` |
| `packages/langfuse-mcp` | `build` | `node build.mjs` | `bun build.mjs` |
| 根 | `test:ingestion` | `node scripts/test-ingestion-isolated.mjs` | `bun scripts/test-ingestion-isolated.mjs`（需实测） |
| 根 | `release` | `node scripts/release.mjs` | `bun scripts/release.mjs` |
| 根 | `dev` | `concurrently …` | `concurrently` 是 Node 工具；可换 `bun --filter` 或保留 |
| 全部 | `build` / `typecheck` | `tsc` | **保持不变**（tsc 与运行时无关，Bun 执行 `tsc` 亦可） |
| 全部 | `test`（shared/web/gateway/server/langfuse-mcp） | `vitest run` | **保持 vitest**，但需加 Bun 侧 pool 覆盖（阻塞项 2） |

### 6.5 CI

| 路径 | 现状 | 改法 |
| --- | --- | --- |
| `.github/workflows/docker-ghcr.yml` | buildx 多架构 `linux/amd64,linux/arm64` 构建 Dockerfile | 随 Dockerfile 改动同步；**多架构原生绑定需逐一验证** |
| `.github/workflows/npm-publish.yml` | `actions/setup-node@v4` (node 22) + pnpm + `pnpm run build`；用 `node -p` 校验 tag 版本、`node -e` 校验发布产物 | 若包仍以 Node 分发，**可不动**；若改为 Bun 发布，需换 `oven-sh/setup-bun`，并把 `node -p`/`node -e` 改写为 `bun -p`/`bun -e`（或保留 Node 仅做校验） |
| （无） | 仓库**没有**测试类 CI workflow（仅 docker 与 npm-publish 两条） | 建议新增时直接用 Bun，并固定 `bun-version: 1.4.2` |

### 6.6 不需要改动

- `turbo.json`、`biome.json`、`pnpm-workspace.yaml`：与运行时解耦。
- `pnpm` 相关配置（`onlyBuiltDependencies`、`patchedDependencies`）：**属于包管理范畴，与运行时正交**。Bun 运行时不要求改用 `bun install`；建议第一阶段继续用 pnpm 安装（两个 patch 是 Turso 驱动的关键修复，迁移包管理器风险高）。

---

## 7. 风险与未验证面

### 已识别风险

1. **Bun 版本敏感**：本次仅验证 **1.4.2**。`node:sqlite` 在 Bun 中属较新能力，且阻塞项 1 的行为可能随版本变化。迁移时必须**固定 Bun 版本**（`oven/bun:1.4.2-*`、CI `bun-version: 1.4.2`）。
2. **vitest 双轨策略**：Bun 下必须偏离仓库默认 `pool: forks`。`vmThreads` 与原语义不同（VM 上下文 vs 独立进程），对依赖进程隔离的用例（`sqlite-read-pool`、`legacy-migration`、`worker-source`）存在**假阴性/假阳性风险**，需逐文件复核。
3. **Turso 原生绑定跨平台**：已在 macOS arm64 验证；Linux glibc/musl、amd64 未验证。Docker 多架构发布前必须逐平台跑一遍阻塞项 1 的复现脚本。
4. **`node:sqlite` 语义差异**：Bun 的实现会在 close 后遗留 `-shm`；大整数 rowid 场景下 Bun 与 Node 行为一致（均抛 `RangeError: Value is too large…` / `ERR_OUT_OF_RANGE`），即**该项无差异**，但整体上不宜假设两套实现完全等价。
5. **`process.execPath` 语义变化**：CLI 现有代码因 `process.execPath` 在 Bun 下返回 bun 而"恰好可用"。但这意味着**一旦用户机器上 CLI 由 Bun 启动，daemon 也必然是 Bun**；若采用混合分发（npm + Bun），需明确文档化。
6. **`.env` 覆盖 `process.env`**：`packages/cli/src/lib/daemon.ts:83` 的合并顺序会让 `.env` 中的 `LITE_SERVER_PORT`、`SALT` 等压过调用方传入的变量。迁移到 Bun 不改变此行为，但它会让"用环境变量覆盖"的调试方式失效，易造成误判。
7. **发布/分发策略未定**：`peri-fuse` 是发到 npm 的 CLI（`.github/workflows/npm-publish.yml`）。若要求用户安装 Bun，是显著的分发门槛变化。可选路径：(a) 保持 Node 作为对外分发运行时、Bun 仅用于开发/自托管；(b) 双产物；(c) 全面转 Bun 并在 `engines`/文档中强制。

### 未验证面（本次刻意跳过或未覆盖）

| 项 | 原因 |
| --- | --- |
| Linux / Docker 镜像内的 Bun 行为 | 未构建容器；仅在本机 macOS arm64 实测 |
| `@tursodatabase/serverless`（远程 Turso）真实调用 | 需真实远端服务；**仅验证 import 与导出**，未构造连接 |
| `@tursodatabase/serverless` 的 patch（`patches/…@1.4.1.patch`）在 Bun 下的运行时效果 | 同上 |
| web 包（vite build / vitest）在 Bun 下 | 按任务要求避免全量 web 构建 |
| `@peri/gateway` 包测试套件在 Bun 下 | 时间预算；仅覆盖 server 启动链路 |
| `@peri-fuse/langfuse-mcp` 构建与测试 | 未覆盖 |
| `bun install` 替代 pnpm | 未评估；两个 Turso patch 与 `onlyBuiltDependencies` 是 pnpm 专属机制 |
| vitest `forks`/`threads` pool 失败的**根因修复** | 仅定位并绕过，未修 |
| `OtelIngestionProcessor` 导出冲突的具体触发依赖 | 仅定位到错误信息，未追到具体模块 |
| `scripts/perf-trace-bench.mjs`、`prune-telemetry.mjs`、`seed.mjs`、`session-search-benchmark.mjs` | 未逐一审计 `node:` API 使用 |
| Node 22（CI/Docker 版本）基线对比 | 本机 Node 为 v26.9.0，与 CI 的 node 22 存在版本差 |

---

## 8. 建议的提交切分次序

每一步都可独立验证、可独立回滚。

**Step 0｜先决条件（不落代码）**
解决阻塞项 1 的策略选型（推荐方案 A：迁移脚本保留 `NODE_BINARY=node`），并在 Linux amd64/arm64 上复跑阻塞项 1 的复现脚本。
*验证*：三平台均确认 Bun 下迁移脚本失败、Node 下成功，据此冻结方案。

**Step 1｜只加文档，不改行为**
新增 `docs/bun-runtime.md`（本文），记录实测结论、阻塞项与未验证面。
*验证*：`pnpm run lint`。

**Step 2｜CLI 测试轨切到 `bun test`（风险最低、收益明确）**
`packages/cli/package.json` 的 `test` 改为 `bun test test/`。
*验证*：`bun test` 12/12 通过（已验证）。

**Step 3｜Bun 可运行 server（不改默认运行时）**
新增脚本（如 `start:bun` / `dev:bun`）指向 `bun dist/index.js`、`bun --watch src/index.ts`，**保留**原有 `node`/`tsx` 脚本不动。
*验证*：按 Spike 1 全流程回归——health、ingestion 写入回读、SPA、SIGTERM。

**Step 4｜修 e2e 的硬编码运行时**
`packages/server/e2e/run.mjs` 的 4 处 `spawn("node", …)` 改为 `process.execPath`。
*验证*：`node e2e/run.mjs` 与 `bun e2e/run.mjs` 结果一致。

**Step 5｜测试矩阵加 Bun 一轨**
为 vitest 增加 Bun 覆盖配置（`--pool=vmThreads`），**不修改**默认 `pool: forks`；对 Spike 3 中失败的 6 个用例逐一分类处置（框架层绕行 / 断言层放宽）。
*验证*：Node 轨保持 298/298；Bun 轨失败用例清零或有明确豁免记录。

**Step 6｜Dockerfile 迁移**
改造 base/runtime 为 Bun 镜像 + 同步 `packages/server/src/docker-build-config.test.ts`、`packages/server/src/container-port-config.test.ts`。
*验证*：`docker build` 多架构通过；容器内 health/injection/ingestion 冒烟；`NODE_BINARY` 语义确认。

**Step 7｜声明与文档收口**
`engines` 字段、`README.md`、`CLAUDE.md`、`AGENTS.md`、`docs/embedded-turso.md`、`docs/legacy-db-migration.md` 同步。

**Step 8｜CI**
`docker-ghcr.yml` 随 Dockerfile 同步；视发布策略决定是否新增 `oven-sh/setup-bun` 测试 workflow（固定 `1.4.2`）。

**Step 9｜发布策略决策（独立议题）**
确定 `peri-fuse` 的对外分发运行时（Node / Bun / 双产物），再决定 `packages/cli/package.json` 的 `engines` 与 npm-publish workflow 的改动。

---

## 附录 A：复现用的关键命令

```bash
# 构建（不触碰 web）
pnpm --filter @peri-fuse/shared run build \
  && pnpm --filter @peri/gateway run build \
  && pnpm --filter @peri-fuse/server run build

# Bun 启动 server（隔离环境，从 /tmp 启动以避开仓库 .env）
cd /tmp && PERIFUSE_HOME=/tmp/bun-spike/home LITE_SERVER_PORT=23999 \
  bun <repo>/packages/server/dist/index.js

# CLI（隔离 PERIFUSE_HOME，避免污染 ~/.peri-fuse）
PERIFUSE_HOME=/tmp/bun-spike/cli-home bun <repo>/packages/cli/dist/index.js start|status|stop

# vitest（必须指向 JS 入口，不能用 .bin/vitest 包装脚本）
cd packages/shared && bun ./node_modules/vitest/vitest.mjs run --pool=vmThreads

# CLI 测试
cd packages/cli && bun test test/

# 阻塞项 1：切换 NODE_BINARY 对比
NODE_BINARY=bun  bash scripts/migrate-legacy-db.sh --source-dir … --target-dir … --offline  # 失败
NODE_BINARY=node bash scripts/migrate-legacy-db.sh --source-dir … --target-dir … --offline  # 成功
```

## 附录 B：依赖嗅探原始输出

```
PASS  winston(createLogger+json+File/Console) ::
      wrote 1 JSON line(s): {"a":1,"level":"info","message":"spike hello","timestamp":"…"}
PASS  @opentelemetry/sdk-trace-base ::
      flushed 1 span(s): name="op" attr.k="v"
PASS  @tursodatabase/serverless ::
      exports=[Connection,DatabaseError,ENCRYPTION_KEY_HEADER,Session,Statement,
               TimeoutError,Transaction,connect,decodeValue,encodeValue]
      (construct-only, no network attempted)
PASS  @hono/node-server serve() ::
      GET /hi -> HTTP 200 {"ok":true,"rt":"bun"};
      listening callback info={"address":"::","family":"IPv6","port":24001}
PASS  node:child_process :: spawn available (used by CLI daemon)
```

> 嗅探注意：脚本若放在 `/tmp`，Bun 会回退到全局缓存（`~/.bun/install/cache`）并自动安装依赖，**不能反映仓库真实依赖**。正确做法是让脚本在对应包目录内解析（`cd packages/shared && bun …`），以命中 pnpm 的 `node_modules`。
