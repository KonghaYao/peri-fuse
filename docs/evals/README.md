# Langfuse Lite — Eval 支持路线图总览

> 目标：在保持「纯 SQLite、零外部基础设施、projectId 隔离、Langfuse SDK 兼容」四项硬性约束的前提下，
> 分阶段补齐 langfuse 的 eval 能力：score 配置闭环 → annotation queues → datasets / eval 配置 → eval 执行引擎。

## 1. 现状盘点结论

以下结论基于本仓库当前代码（文件:行号均为验证过的现状）。

### 1.1 Score 链路（P1 核心）

| 能力 | 现状 | 位置 |
|------|------|------|
| `score_configs` 表 | ✅ 已存在（含 projectId） | `packages/shared/src/db/schema/schema.ts:316` |
| scoreConfigs 领域逻辑 | ✅ 较完整（index + validation） | `packages/shared/src/features/scoreConfigs/` |
| ingestion 中的 score 事件 | ✅ 支持（含 ANNOTATION 类型校验、configId 归属校验） | `packages/shared/src/server/ingestion/validateAndInflateScore.ts`（注释明确 Central choke point） |
| `processEventBatchLite` 写库 | ✅ 支持 score 事件 + EVALUATOR observation 类型 | `packages/shared/src/server/ingestion/processEventBatchLite.ts:66` |
| GET /api/public/scores | ✅ 已实现，带分页 meta + responseCache(2000) | `packages/server/src/routes/scores.ts:16` |
| **POST /api/public/scores** | ❌ 缺失（validateAndInflateScore 注释预留了该入口，路由未接线） | `packages/server/src/routes/scores.ts` 仅有 GET |
| **score configs CRUD API**（GET/POST /api/public/score-configs） | ❌ 缺失 | — |
| web 分数配置页（scores 设置） | ❌ 缺失（web 有 scores 展示页，无配置管理） | `packages/web/src/features/` 无 scoreConfigs |

### 1.2 Eval 配置（P1 配置 CRUD / P3 执行）

| 能力 | 现状 | 位置 |
|------|------|------|
| `eval_templates` 表 | ✅ 已存在 | `schema.ts:641` |
| **`eval_configs` 表** | ❌ 不存在（上游 main 分支同样无 EvalConfig model，eval config 实体即 `job_configurations`；采用决策点 D1：默认 B 不建表、API 直读写 `job_configurations`，A 建表为备选，见 [phase-1-api-compat.md](./phase-1-api-compat.md) §7 D1） | — |
| evals 类型 | ⚠️ 显式 stub（仅 EvalTargetObjectSchema 枚举，注释 not available in lite mode） | `packages/shared/src/features/evals/types.ts:1` |
| evals 阻塞逻辑 | ⚠️ 显式 stub（JobConfigExecutionMode 枚举，注释 not available in lite mode） | `packages/shared/src/features/evals/evalConfigBlocking.ts:1` |
| eval config CRUD API | ❌ 缺失 | — |

### 1.3 Datasets（P2 核心）

| 能力 | 现状 | 位置 |
|------|------|------|
| `datasets` / `dataset_items` / `dataset_runs` 表 | ✅ 已存在（均含 projectId） | `schema.ts:395 / 416 / 448` |
| datasets 校验逻辑 | ✅ 校验函数存在 | `packages/shared/src/features/datasets/validation.ts` |
| datasets CRUD API | ❌ 缺失 | — |
| dataset items / runs API | ❌ 缺失 | — |

### 1.4 Annotation Queues（P4 核心）

| 能力 | 现状 | 位置 |
|------|------|------|
| `annotation_queues` / `annotation_queue_items` / `annotation_queue_assignments` 表 | ✅ 已存在（均含 projectId） | `schema.ts:339 / 354 / 376` |
| annotation 类型 | ✅ 类型 + zod schemas（CreateQueueData / CreateAnnotationScoreData 等；无路由/服务/写库） | `packages/shared/src/features/annotation/types.ts` |
| queue CRUD / items / assignments API | ❌ 缺失 | — |
| ingestion 关联（score 挂 queueId） | ⚠️ GET scores 已支持 `queueId` 过滤（`scores.ts:37`），但 queue 本身无 API | — |

### 1.5 执行引擎（P3 核心）

| 能力 | 现状 | 位置 |
|------|------|------|
| `job_executions` 表 | ✅ 已存在（含 jobTemplateId / jobInputDatasetItemId 字段；evalTemplateId 在 job_configurations） | `schema.ts:687`（jobTemplateId :693 / jobInputDatasetItemId :701；job_configurations :674） |
| `experiments` 工具 | ⚠️ 仅 utils（无 API / 无写库） | `packages/shared/src/features/experiments/utils.ts` |
| eval 执行 worker / runner | ❌ 引擎本体缺失（进程内 worker 框架已存在，可注册队列 processor） | `packages/shared/src/server/worker/in-process-worker.ts`（InMemoryQueueAdapter，无 Redis） |
| dataset runs 回写 | ⚠️ 仓储层已有未接线的 createOrFetchDatasetRun（含唯一约束并发处理），无 API 与执行回写 | `packages/shared/src/server/repositories/dataset-runs.ts:41` |
| worker/queues 资产 | ✅ 可复用：queues.ts 仅 zod 队列定义（已含 EvaluationExecution / CreateEvalQueue / LLMAsJudgeExecution 等 eval 事件 schema，queues.ts:353-356/378），不依赖 redis/clickhouse；真正依赖外部服务的是 `server/redis/`、`server/clickhouse/` 目录 | `packages/shared/src/server/queues.ts` |

### 1.6 Web UI（各阶段随附）

| 能力 | 现状 | 位置 |
|------|------|------|
| 现有页面 | dashboard / gateway / observations / onboarding / scores / sessions / settings / traces / users | `packages/web/src/features/` |
| evals / datasets / annotation-queues 页面 | ❌ 全部缺失 | — |
| 数据层 | tanstack query（`useXxxQuery` 模式）+ shared/lib/api.ts | `packages/web/src/shared/hooks/queries.ts` |

## 2. 阶段矩阵

| 阶段 | 范围 | 依赖 | 工作量预估 | 状态 |
|------|------|------|-----------|------|
| **P1** API 兼容层 | score configs CRUD；POST /api/public/scores 接线；eval configs / eval templates CRUD（决策点 D1：默认不建 `eval_configs` 表，API 直读写 `job_configurations`，A 建表为备选）；features/evals stub 替换；e2e 扩展。任务清单见 [phase-1-api-compat.md](./phase-1-api-compat.md) | 无（表与领域逻辑基本就绪） | M（1 人周） | pending |
| **P2** Datasets | datasets / items（validFrom 版本化）/ runs 元数据 CRUD API；features/datasets 域逻辑补全；e2e。任务清单见 [phase-2-datasets.md](./phase-2-datasets.md) | P1（复用路由/校验/分页模式） | M | pending |
| **P3** Eval 执行引擎 | 轮询主路径（进程内 setInterval，本阶段不引入队列消费；in-process-worker 资产仅作并发模型参考）；job_executions 状态机；template 渲染；复用 gateway 的 resolveModel + createAdapter 调 judge（凭证取自 gateway 库 Provider.apiKeyEncrypted / Credential.values，见 [phase-3-eval-engine.md](./phase-3-eval-engine.md) D5）；score 写回 | P1（eval configs 定义 + score 写回通道） | XL（3 人周） | pending |
| **P4** Web UI + Annotation Queues | annotation queues server API + 域逻辑补全；web evals / datasets / annotation-queues 三页面与导航入口。任务清单见 [phase-4-web-ui.md](./phase-4-web-ui.md) | P1–P3（页面依赖各阶段 API） | L（2 人周） | pending |

> 工作量预估为相对量级（S=2~3 天，M=1 周，L=2 周，XL=3 周），不含联调与打磨。

## 3. 依赖图

```
┌───────────────────────────┐
│ P1  API 兼容层             │
│ score configs / POST scores│
│ eval configs / templates   │
└──┬────────┬────────┬──────┘
   │        │        │
   │        │        └──────────► P4 Web UI + Annotation Queues
   │        │                     （score 链路 + 页面依赖全部 API）
   │        └──────────────► P3 Eval 执行引擎
   │                           （eval configs 定义 + score 写回通道）
   ▼
┌───────────────┐
│ P2 Datasets   │（dataset items 预留为后续 dataset eval 输入，本期引擎不消费）
└───────────────┘
```

依赖关系汇总：

- `P1 → P2`：datasets CRUD 复用 P1 建立的路由/校验/分页模式；P3 的 `job_input_dataset_item_id` 字段仅为后续 dataset eval 预留，本期引擎不消费。
- `P1 → P3`：eval configs 是引擎的输入定义，score 写回通道（POST scores / ingestion）是引擎的输出。
- `P1 → P4`：annotation queues 上的标注 score 依赖 P1 的 score 链路；web 页面依赖各阶段 API。
- `P2 → P3`（未来增强）：dataset items 可作后续 dataset eval 的批量评测输入，本期引擎不消费（phase-3 D3：targetObject=dataset_run_item 的 config 跳过并 warn）。
- `P3 → P4`：web evals 页面的运行记录展示依赖 P3 的 `job_executions` 数据。
- P2 与 P4 部分互不依赖，人员充足时可在 P1 完成后并行。

## 4. 通用约定

所有新增 API / 逻辑必须遵守以下约定（与现有代码保持一致）：

### 4.1 认证

- 公共 API（`/api/public/*`）一律使用 `authMiddleware`（`packages/server/src/auth.ts`），
  Basic 认证（publicKey:secretKey），鉴权结果挂在 `c.get("auth")`，**严禁绕过**。
- `/api/manage/*` 是本地管理 API，不要求 pk/sk（`routes/manage.ts`），新页面归属公共 API 时不得借用该豁免。
- Gateway 侧统一走 gateway 的 `middleware/auth.ts`（project-scoped API key），与 server 公共 API 认证互不混用。

### 4.2 projectId 隔离（硬性）

- 每个新增路由处理函数第一件事：取 `auth.scope.projectId`。
- 所有查询/写入必须带 `projectId` 过滤；`configId` / `queueId` / `datasetId` 等外键引用必须按
  `(projectId, id)` 联合校验归属，参考 `validateAndInflateScore.ts` 中 scoreConfigs 的查法。
- 新增集成测试必须覆盖跨 projectId 越权场景（引用他人资源返回 404/403）。

### 4.3 分页与列表响应

- 列表响应统一 `{ data: [...], meta: { page, limit, totalItems, totalPages } }`，
  对齐 `GET /api/public/scores`（`scores.ts:59-69`）。
- 分页参数统一 `page`（1 起）+ `limit`，从 zod schema 解析，非法参数返回 400。

### 4.4 错误响应

- 业务错误一律抛 `BaseError` 子类（`InvalidRequestError` → 400、`LangfuseNotFoundError` → 404 等），
  由 `app.ts` 全局 `onError`（`app.ts:52-64`）统一映射；不在路由内手写状态码。
- 未知字段/结构校验失败 → 400（`zod` 解析层）。
- 错误响应中不得泄漏堆栈、SQL 或密钥。

### 4.5 响应缓存

- 仅对**幂等 GET** 使用 `responseCache(ms)`（`packages/server/src/response-cache.ts`），
  参考 `scores.ts:16` 的 `responseCache(2_000)`。
- 写操作（POST/PATCH/DELETE）不得缓存；缓存键必须包含 projectId 维度（默认按 URL + auth 隔离）。

### 4.6 测试基座（helpers）

- 集成测试统一使用 `packages/server/src/__tests__/helpers.ts`：
  `getApp()`（进程内 Hono app，不绑端口）、`apiGet(path, auth?)`、`apiPost(path, body, headers?, auth?)`
  （body 传 `Uint8Array` 时自动切 protobuf content-type，用于 ingestion）、
  `basicAuth(publicKey, secretKey)`（默认 `TEST_PUBLIC_KEY` / `TEST_SECRET_KEY`，来自 `test-db-paths.ts`）。
- DB 由 `global-setup.ts` 准备的临时 SQLite；新测试文件参照 `ingestion-roundtrip.test.ts` 的种子模式。
- SDK 兼容回归走 `packages/server/e2e/langfuse-sdk-e2e.mjs`（现覆盖 trace/score/sessions/users/dashboard），
  每个阶段完成后向其中追加对应 SDK 调用（scores POST、datasets、eval 相关）。

### 4.7 文件与依赖约束

- 单文件 ≤ 500 行，超限即拆模块（遵循现有 routes/ / features/ 分层）。
- 禁止引入 Redis / ClickHouse / S3 / BullMQ 等外部服务；worker 类逻辑（P3 引擎）必须进程内实现。
- 新增共享逻辑放 `packages/shared/src/features/<domain>/`，路由放 `packages/server/src/routes/`，
  页面放 `packages/web/src/features/`，数据请求走 `packages/web/src/shared/hooks/queries.ts` 既有模式。

### 4.8 双库架构（新增表必须先判定归属）

- **metadata 库** `.langfuse/langfuse.db`：organizations / projects / api_keys / score_configs /
  datasets* / eval_templates / job_executions 等 67 张表，由 drizzle 迁移
  （`packages/shared/drizzle/*.sql`）经 `client.ts:ensureSchema()` 一次性应用。新增 metadata 表
  （如决策点 D1 备选方案的 `eval_configs`，默认不建表）→ `drizzle-kit generate` 新迁移（P1 T1）。
- **telemetry 库** `.langfuse/telemetry.db`：traces / observations / trace_metrics / daily_stats /
  daily_model_stats / scores 共 6 张表，由 `sqlite-telemetry-adapter.ts:initializeSchema()`
  手写 `CREATE TABLE IF NOT EXISTS` 管理，**不走 drizzle**（drizzle 0000 迁移不含遥测表）。
  新增遥测表（如 `dataset_run_items`）→ 改 adapter（P2 T2）。
- **升级陷阱**：`ensureSchema()` 仅以 `organizations` 表是否存在判断是否应用迁移（非增量），
  既有库不会自动应用新增迁移；P1 T1 已含改造为增量迁移的任务，实施时须优先处理。

## 5. 总验收标准

1. **质量门禁**：`pnpm run typecheck && pnpm run lint && pnpm run test` 全绿；
   gateway 相关改动需通过 `pnpm --filter @peri/gateway run test`；web 改动需 `pnpm --filter @peri-fuse/web run build`。
2. **SDK 兼容**：langfuse SDK 对 score / score-configs / datasets / eval 的标准调用在
   `langfuse-sdk-e2e.mjs` 中全部通过；新增端点保持 v1 响应形状（含 meta 分页）。
3. **隔离无例外**：每个新增表/端点均有 projectId 越权测试；代码审查中不得出现未过滤 `projectId` 的查询。
4. **零外部设施**：全路线图不引入任何需要独立部署的服务；P3 执行引擎为进程内实现。
5. **约束合规**：所有新增/修改文件 ≤ 500 行；错误走 BaseError 统一映射；写操作不缓存。
6. **UI 闭环**：每阶段交付的 API 均有对应 web 页面（列表 + 创建/编辑表单），并接入 tanstack query 与
   shared/lib/api.ts；dashboard 能展示 P3 的 eval 实验结果。
7. **数据可回查**：P3 完成后，一条 eval 执行可从 `job_executions` → `job_input_trace_id` /
   `job_input_observation_id` → traces/observations → score 全链路追踪，与 ingestion 写入的 score
   在 `GET /api/public/scores` 中一致可见；dataset 链路（`job_input_dataset_item_id` →
   `dataset_run_items`）随后续 dataset eval 增强补全。
