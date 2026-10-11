# 交接文档：Bun 运行时迁移 + PERIFUSE_ENGINE=sqlite

- **日期**：2026-10-11
- **状态**：两个实施工作流在模型侧传输故障后中断；**工作区改动未经验证**。本文档基于只读盘点（`.peri/plans/inventory-bun-sqlite.md`）与 git 现状核对，供接续者直接使用。
- **续报**：会话重启后已由主会话完成验证、补缺与提交，实际结果见文末 **§7 收尾状态**；§1–§6 保持中断时刻的原样。

## 1. 目标

1. **Bun 运行时迁移**：产品运行时（server / gateway / CLI daemon / Docker / 启动与 dev 脚本 / engines / 文档）迁到 Bun。
2. **`PERIFUSE_ENGINE=sqlite`**：在保留 Turso 默认引擎的前提下，本地嵌入式引擎可切换为 Bun 内置 `bun:sqlite`；远程 Turso 配置优先级不变。

## 2. 执行历史与中断记录

| 工作流 | Owner | 结果 |
|---|---|---|
| recon + spike | bun-recon | ✅ 交付 `docs/bun-runtime.md` |
| 实施级设计规格 | sqlite-design | ✅ 交付 `docs/sqlite-engine.md` |
| 实施 A（Bun 迁移） | bun-migration | ⚠️ 中断：零输出（疑似模型超时）；**改动已落盘、未验证** |
| 实施 B（sqlite 引擎） | sqlite-impl | ⚠️ 中断：先 transport 失败（重试 6 次耗尽）、resume 后再静默；**改动已落盘、未验证** |
| 只读盘点 | workspace-inventory | ✅ 交付 `.peri/plans/inventory-bun-sqlite.md` |

中断根因与平台问题记录见 `docs/peri-feedback-2026-10-11.md`。**两个实施任务从未交付验收报告**——下文所有"已完成"仅指"磁盘上已存在且经只读比对"，不代表通过任何验证。

## 3. 磁盘现状（全部未提交）

统计：**17 个已跟踪文件被修改 + 11 个新文件（未跟踪）**。

### 3.1 工作流 A（Bun 迁移）已完成面

- `Dockerfile`：bun 二进制来自新增的 `oven/bun:1.4.2-debian` stage；runtime 阶段保留 `node:22-bookworm-slim` 与 `NODE_BINARY=node`（专供 legacy 迁移脚本）；`CMD ["bun", …]`；`HEALTHCHECK` 改为 bun + 顶层 `await fetch`。
- 根 `package.json`：`engines.bun >= 1.4.2`；`svc*` 脚本改为 `bun packages/cli/dist/index.js`。
- `packages/{cli,server,gateway,langfuse-mcp}/package.json`：start / dev / test / e2e 脚本切 Bun（cli 的 test → `bun test test/`）。
- `packages/server/src/docker-build-config.test.ts`、`container-port-config.test.ts`：断言同步为 bun（`["bun","-e"]` 等）。
- `packages/cli/build.mjs`、`packages/cli/src/lib/daemon.ts`、`packages/server/e2e/run.mjs`：运行时调用点改用 `process.execPath`。
- 文档：`README.md`、`CLAUDE.md`、`AGENTS.md`、`packages/gateway/AGENTS.md`、`docs/bun-runtime.md`（已含实施状态章节）。
- 有意未改（文档判定无需改/不在范围）：`turbo.json`、`dev.sh`、`.github/workflows/*`。

### 3.2 工作流 A 缺失/待办

- `packages/shared/package.json`：`engines` 缺 `bun`（文档"最终形态"要求）。
- `packages/shared/AGENTS.md`：未补运行时分工说明。
- `docs/embedded-turso.md:8-9`：未更新（文档列为"已知遗留"）。

### 3.3 工作流 B（sqlite 引擎）已完成面

- `packages/shared/src/db/connection-config.ts`：`resolveLocalEngine()` —— 只读 `PERIFUSE_ENGINE`（`ENGINE` 不生效）、非法值抛 `PERIFUSE_INVALID_ENGINE`。
- `packages/shared/src/db/local.ts`：`createLocalDatabase` 按 remote → sqlite → turso 分派；`assertSqliteRuntime()` 前置（先于创建目录/文件）；迁移与初始化路径接入 sqlite 分支。
- `packages/shared/src/db/errors.ts`：错误码扩展。
- 新增 `sqlite.ts`（493 行）、`sqlite-native.ts`（76）、`sqlite-statement.ts`（414）、`sqlite-transaction.ts`（183）：FifoGate 串行化单连接、AsyncLocalStorage 事务作用域、BEGIN 重试、惰性 `import("bun:sqlite")` + 运行时 guard（`PERIFUSE_SQLITE_REQUIRES_BUN`）。
- 新增 5 个测试：`sqlite.test.ts`、`sqlite-statement.test.ts`、`sqlite-transaction.test.ts`、`sqlite-values.test.ts`、`sqlite-concurrency.test.ts`（含确定性时钟与 `PERIFUSE_SQLITE_PRESSURE` 开关）。
- `packages/gateway/src/db.ts` 无需改动（经 `createLocalDatabase` 分派）。
- 无调试残留（无 `.probe` / `/tmp` 引用 / TODO / stub）。

### 3.4 工作流 B 缺失/待办

- `docs/sqlite-engine.md`：第 3 行仍写"尚未实施"（**最易误导接续者**），且未追加"实施状态"小节。
- 缺 `packages/gateway/src/__tests__/sqlite-engine.test.ts`（规格 §8.2）。
- 缺 `packages/cli/src/__tests__/sqlite-engine.test.ts`（规格 §8.2）。
- `packages/shared/package.json` 缺 `@types/bun`；`packages/shared/tsconfig.json` 的 `types` 仍为 `["node"]`（规格 §3.1）。
- `packages/cli/build.mjs`：`bun:sqlite` 未加入 external（因 `sqlite-native.ts` 用非字面量动态 import，esbuild 静态不可解析，必要性待实测确认）。
- server 侧测试未补 sqlite 覆盖（`sqlite-read-pool` / `session-search` / `worker-source`）。
- 规格 §8.3 压力验收未执行、无记录。

## 4. 接续步骤（建议顺序）

1. **先验证、再补缺**：`pnpm run typecheck`、`pnpm run lint`，分类修复。
2. 工作流 A 验收（对照 `docs/bun-runtime.md` 的验收五项）：受影响 vitest 套件（Node 基线）；`bun packages/cli/dist/index.js start/status/stop`；隔离环境 Bun 起 server 冒烟（`PERIFUSE_HOME=/tmp/…`、`LITE_SERVER_PORT=…`）；可选 `docker build`。
3. 工作流 B 验收（对照 `docs/sqlite-engine.md`）：默认引擎回归（Turso 行为不变）；`PERIFUSE_ENGINE=sqlite` 下跑新测试 + 既有 db 测试；Bun 下真实文件冒烟（事务 / worker / 只读 / 与 Turso 文件的互操作）；Node 下 `PERIFUSE_ENGINE=sqlite` 的报错行为。
4. 补齐 §3.2 / §3.4 缺失项。
5. **联合验收**：Bun × `PERIFUSE_ENGINE=sqlite` 交叉冒烟（server 启动 + 写入 + 读池）。
6. **提交**（用户此前要求"完成之后提交改动"，尚未执行）：建议分两笔——`Bun 运行时迁移` 与 `PERIFUSE_ENGINE=sqlite 引擎支持`；注意 `packages/cli/build.mjs` 被两个工作流共同触达。

## 5. 必读背景与坑

- `PERIFUSE_ENGINE` 语义与错误码（`PERIFUSE_INVALID_ENGINE` / `PERIFUSE_SQLITE_REQUIRES_BUN`）以 `docs/sqlite-engine.md` 为准。
- **`bun:sqlite` 与 Turso `multiprocess_wal` 不可混用同一文件**（Bun 下会锁错误）→ legacy 迁移脚本保留 `NODE_BINARY=node`；Docker runtime 保留 node。
- 测试双轨：vitest 维持 Node 基线（298/298）；Bun 下 vitest 默认 pool 不可用（见 `docs/bun-runtime.md` 已知限制）；CLI 套件用 `bun test`。
- 环境残留：`/tmp/db-compat-test/`（兼容性探针脚本与数据库）；`packages/shared/node_modules/.probe-bun-*.ts`（探针脚本，随 node_modules 清理）。
- **卡死任务复活风险**：`bun-migration`、`sqlite-impl` 在宿主侧可能仍为 active 状态（工具层无法取消）。接续前先确认工作区无新写入（`git status` 快照比对、文件 mtime 检查）。

## 6. 参考

- `docs/bun-runtime.md` —— 迁移清单、9 步次序、风险
- `docs/sqlite-engine.md` —— 引擎规格（方法级契约）；《实施状态》为最终验收矩阵
- `.peri/plans/inventory-bun-sqlite.md` —— 只读盘点报告（剩余动作清单）
- `docs/peri-feedback-2026-10-11.md` —— 本次系统故障记录

## 7. 收尾状态（2026-10-11 续，主会话）

§3.2 / §3.4 缺失项全部处理完毕，核心验收已执行；结论与证据汇总在
`docs/sqlite-engine.md` 的《实施状态》小节。要点：

- **评估结论：Bun 侧 vitest 统一使用默认 `pool: forks`**。此前建议的 `vmThreads` 实测不可用——VM 上下文内 `import("bun:sqlite")` 抛 `exportNames.default is duplicated`（`ERR_INVALID_ARG_VALUE`），任何 sqlite 代码都无法运行；`forks` 下 sqlite 套件全绿。
- **§3.2**：`packages/shared/package.json` 已补 `engines.bun`；`packages/shared/AGENTS.md` 已补《Runtime & local engines》（含 Bun 侧 sqlite 测试命令）；`docs/embedded-turso.md` 开头已改写；根 `AGENTS.md` 规则 6 与 `CLAUDE.md` 同步（含 Vitest-on-Bun 的唯一例外说明）。
- **§3.4**：
  - `docs/sqlite-engine.md` 状态行已改并追加《实施状态》；`packages/gateway/test/sqlite-engine.test.ts`（4 例）与 `packages/cli/test/sqlite-engine.test.ts`（4 探针 + `PERIFUSE_SQLITE_E2E=1` 门控的 3 个 daemon e2e）已新增——仓库测试目录惯例是 `test/`，不是规格写的 `src/__tests__/`。
  - `@types/bun` **有意不加**、tsconfig 保持 `["node"]`：实现用非字面量动态 import，TypeScript 永不解析 `bun:sqlite`，以结构化接口 + 运行时 guard 替代（规格 §3.1 的偏离说明见 `docs/sqlite-engine.md`）。
  - `packages/cli/build.mjs` 三处 esbuild 已加 `bun:sqlite` external。实测：非字面量 import 不触发解析（无 external 也可构建），但改回字面量会让 esbuild 直接失败，external 是对此回归的防护。
  - server 侧 sqlite 覆盖：`session-search/{lifecycle,worker-source,backfill,context,extraction}` 在 Bun+sqlite 下 22/22 通过（含 worker 启停与恢复）；`sqlite-read-pool.test.ts`／`query.test.ts` 因 vitest×Bun 加载器问题（`z.coerce` undefined，同 `remote.test.ts`）无法在 Bun 下加载，新增 `packages/shared/scripts/sqlite-read-pool-smoke.ts` 以 `bun run` 直跑覆盖只读 worker、行数限额、超时替换与写连接并存。
  - 压力：仓库精简压力用例（`PERIFUSE_SQLITE_PRESSURE=1`）8/8 通过；规格 §8.3 的完整七场景压力矩阵**未执行**，作为遗留记录在此。
