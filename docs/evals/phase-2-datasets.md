# Phase 2: Datasets —— 数据集 CRUD、items 版本化、runs 元数据

## 目标

为 lite server 提供与 Langfuse SDK 兼容的 Datasets 公共 API：数据集 CRUD、dataset items（含版本化语义）、dataset runs 元数据管理与查询（run items 通过 ingestion 事件写入，run 详情聚合关联 scores）。

一句话：**"SDK 能建数据集、灌数据、跑实验（run 元数据 + run items），并能通过公共 API 查询 run 详情与其上的 scores"。**

可验收标准：

- `POST/GET /api/public/datasets`、`GET/PATCH/DELETE /api/public/datasets/{datasetId}` 可用，名称唯一（409）、不存在（404）、校验失败（400）语义正确。
- `POST/GET /api/public/datasets/{datasetId}/items`、`PATCH/DELETE .../items/{itemId}` 可用；同 id 重复写入产生新版本行（旧行 `validTo` 关闭），GET 只返回当前版本；DELETE 为软删除。
- ingestion 事件 `dataset-run-item-create` 被 lite 路径写入 `dataset_run_items` 表；`GET /api/public/datasets/{datasetId}/runs/{runId}` 返回 run + items + 每 item 的 input/expectedOutput（取 item 当前版本）+ 关联 scores（按 trace join）。
- 所有读写均按 `auth.scope.projectId` 隔离（跨项目 key 访问返回 404/空）。
- `pnpm run typecheck && pnpm run lint && pnpm run test` 通过；e2e（langfuse SDK v3 datasets API）通过。
- 不引入任何外部服务；单文件 ≤ 500 行；本阶段不实现 dataset run 的执行/调度逻辑（执行由 SDK experiments 在客户端驱动）。

## 前置依赖

- Phase 1 已完成：`authMiddleware` 统一鉴权（scope/类型声明在 `packages/server/src/auth.ts:29-39`，中间件本体 :172，`c.get("auth").scope.projectId`）、ingestion lite 路径（`processEventBatchLite.ts`）、`responseCache`、`{ data, meta }` 分页响应模式（`routes/scores.ts`）。
- 数据库双库架构已就绪（见现状 §1-§2）。
- 本阶段不依赖 Phase 3（Evals）的任何内容；不新建 `eval_configs` 表（`job_configurations` 已承载全部 eval config 字段，见 Phase 3 R4），管理域零新增表。

## 现状（与本阶段相关的代码事实）

### 1. 管理域 DB（元数据，drizzle + better-sqlite3）

- 表定义：`packages/shared/src/db/schema/schema.ts`
  - `datasets`（:395-414）：复合主键 `(id, projectId)`；`uniqueIndex (projectId, name)`；含 `remoteExperimentUrl/Payload/Enabled`、`inputSchema`、`expectedOutputSchema`、`metadata`（TEXT）。
  - `datasetItems`（:416-446）：**物理主键 `(id, projectId, validFrom)`**；`status`（default "ACTIVE"）、`validTo`、`isDeleted`、`sourceTraceId`、`sourceObservationId`、`input`/`expectedOutput`/`metadata`（TEXT，JSON 字符串）；复合 FK `(datasetId, projectId) → datasets` cascade；`dataset_items_project_id_id_valid_from_idx` 索引已具备。
  - `datasetRuns`（:448-469）：复合主键 `(id, projectId)`；`uniqueIndex (datasetId, projectId, name)`；FK cascade。
  - `datasetItemMedia`（:909）：上游 media 引用表，**lite 不实现**（无文件上传），范围外。
- 迁移：`packages/shared/drizzle/0000_free_bucky.sql` 已含三张表（:381-443：`dataset_items` :381、`dataset_runs` :407、`datasets` :424）。`ensureSchema()`（`packages/shared/src/db/client.ts:117-130`）**对已存在库（organizations 表已存在）整体跳过迁移** —— 本阶段不在管理域新增表。
- 访问：`getDb()`（drizzle client，`db/client.ts`）；`prisma` 兼容别名（`db/prisma-compat.ts`）提供 `.query.datasets.findMany` 等；参考 `routes/manage.ts:23-35`（count/eq/orderBy 模式）。
- 类型：`db/types.ts:109-111` 已导出 `Dataset` / `DatasetItem` / `DatasetRuns`（InferSelectModel）；`prisma-enums.ts:68` 导出 `DatasetStatus = "ACTIVE" | "ARCHIVED"`；`domain/dataset-items.ts` 有 `DatasetItemDomain` / `DatasetItemDomainWithoutIO`；`domain/dataset-run-items.ts` 已有 `DatasetRunItemSchema`（run item + run 字段 + item 字段 + `datasetItemVersion`(validFrom)，`shared/src/index.ts:15` 已导出）—— run 详情响应可对齐此形状。

### 2. Telemetry DB（遥测，原始 SQL，better-sqlite3）

- `packages/shared/src/server/adapters/sqlite-telemetry-adapter.ts`：`initializeSchema()`（:125 起）在**每次构造时无条件执行 `CREATE TABLE IF NOT EXISTS` 全集**（traces/observations/scores/trace_metrics/daily_stats 等）—— 新表加在这里即可同时覆盖新库与既有库；`migrateSchema()` 用 `PRAGMA user_version` 做增量迁移，`ensureColumn()`（:394-402）做增量加列。
- `scores` 表（:245-266）：**无 `dataset_run_id` 列**，`trace_id NOT NULL`。lite 查询层（`repositories/lite-queries.ts:829`）对 scores 行强制 `dataset_run_id: null`。
- 查询 API：`getTelemetryDB().query<T>({ query, params })` / `.command` / `.insert` / `.mergeInsert`（:457-518：`query` :457、`command` :481、`insert` :492、`mergeInsert` :518），SQLite 命名参数 `@param`；纯读查询自动走只读 worker 池（`isReadOnlySql`）。

### 3. Ingestion lite 路径

- `packages/shared/src/server/ingestion/processEventBatchLite.ts`：`eventToRow()`（:80-）只处理 `trace` / `observation` / `score` 三类 entity（:99/:123/:162）；写库在 :319-324（`insert` / `mergeInsert`）。
- 事件 schema 已具备：`ingestion/types.ts` 的 `DATASET_RUN_ITEM_CREATE = "dataset-run-item-create"`（:264）、`DatasetRunItemBody`（:547-563，含 `traceId` 必填、`datasetId`/`runId`/`datasetItemId` 必填、`observationId`/`error` 可选、`datasetVersion` 可选）、导出 `datasetRunItemCreateEvent`（:762）。`getClickhouseEntityType()`（`server/clickhouse/schemaUtils.ts`）对 `dataset-run-item-create` 返回 `"dataset_run_item"`（上游 `processEventBatch.ts:330` 同款判断）。
- score 事件：`validateAndInflateScore.ts:128-132` 已处理 `datasetRunId` 的 CORRECTION 拒绝分支；`applyScoreValidation`（`utils/scores.ts:33-51`）允许 `datasetRunId` 独占（不能与 traceId 同传）。

### 4. 路由与共享域现状

- 路由注册：`packages/server/src/app.ts:66-76`（`app.route("/", xxxRoutes)`）；认证后 `c.get("auth").scope.projectId`。
- 参考模式：`routes/scores.ts`（query zod 校验 → 400；`{ data, meta: { page, limit, totalItems, totalPages } }`；`responseCache(2_000)` 仅 GET）；`routes/users.ts`（page/limit 默认 50 / max 500）；`shaping/scores.ts`（查询函数 + 域转换函数分离）；`manage.ts`（drizzle `count()`）。
- 错误映射：`app.ts:52-64` 全局 onError —— `LangfuseNotFoundError → 404`、`BaseError → httpCode`；项目内可用 `BaseError` 子类（`shared/src/errors`）表达 409 等。
- `features/datasets/validation.ts`：仅 `DatasetNameSchema`（`withFolderPathValidation(StringNoHTMLNonEmpty)`），另有 `BulkDatasetItemValidationError` 类型；`shared/src/index.ts:32` 已导出该文件。
- 测试：`packages/server/src/__tests__/`（helpers.ts 提供 `apiGet`/`apiPost`/`basicAuth`，基于 `app.request()` 进程内测试；`global-setup.ts`/`test-db-paths.ts` 管理测试库）；`ingestion/processEventBatchLite.test.ts` 已有事件类型用例（:97 附近）。
- E2E：`packages/server/e2e/langfuse-sdk-e2e.mjs`（SDK `langfuse@^3.38.20`，v3 API 可用 `client.datasets.*` / `client.datasets.runItems.*`；`api()` helper :45-58；`main()` :431-452 注册测试段落）。

## 任务清单

### T1 共享域：补全 `features/datasets`

#### T1.1 新增 `packages/shared/src/features/datasets/types.ts`

- 涉及文件：`packages/shared/src/features/datasets/types.ts`（新增）
- 具体改动：定义公共 API 请求/响应类型（纯类型，不写库）：
  - `DatasetCreateBody`：`name`、`description?`、`metadata?`、`inputSchema?`、`expectedOutputSchema?`（`remoteExperiment*` 不暴露在 create，但保留字段可后续扩展）。
  - `DatasetUpdateBody`：`name?`、`description?`、`metadata?`、`inputSchema?`、`expectedOutputSchema?`。
  - `DatasetItemCreateBody`：`id?`、`input`、`expectedOutput?`、`metadata?`、`sourceTraceId?`、`sourceObservationId?`。
  - `DatasetItemUpdateBody`：`input?`、`expectedOutput?`、`metadata?`、`status?`（`DatasetStatus`）、`sourceTraceId?`、`sourceObservationId?`。
  - `DatasetRunCreateBody`：`name`、`description?`、`metadata?`。
  - 响应类型：`DatasetPublicApi`（id、name、description、metadata、projectId、inputSchema、expectedOutputSchema、createdAt、updatedAt）、`DatasetItemPublicApi`（含 `status`，沿用 `DatasetItemDomain` 的字段取舍，见 `domain/dataset-items.ts:10-25`）、`DatasetRunPublicApi`（含 `datasetId`）。
  - 常量：`DATASET_ITEM_STATUS_ACTIVE` 等（或直接复用 `prisma-enums.ts` 的 `DatasetStatus`）。
- 验证：`pnpm run typecheck`。

#### T1.2 扩展 `packages/shared/src/features/datasets/validation.ts`

- 涉及文件：`packages/shared/src/features/datasets/validation.ts`（修改，现有 22 行）
- 具体改动：新增 zod schema（对齐 `routes/scores.ts` 的"路由内 safeParse + 400"模式）：
  - `DatasetCreateSchema` / `DatasetUpdateSchema` / `DatasetItemCreateSchema` / `DatasetItemUpdateSchema` / `DatasetRunCreateSchema`；`metadata`/`input`/`expectedOutput` 用 `jsonSchema`（`utils/zod`），保持与 ingestion 事件 schema 的 json 语义一致；`status` 限定 `DatasetStatus`。
  - 列表查询 schema：`GetDatasetsQuerySchema`（`page`/`limit` 同 users.ts 默认与上限、`name?`、`id?`）、`GetDatasetItemsQuerySchema`（+`status?`）、`GetDatasetRunsQuerySchema`。
- 验证：`pnpm run typecheck && pnpm run test`（若新增单测则放本文件旁 `validation.test.ts`，非必须）。

#### T1.3 新增 `packages/shared/src/features/datasets/index.ts`

- 涉及文件：`packages/shared/src/features/datasets/index.ts`（新增）
- 具体改动：`export * from "./types"; export * from "./validation";`（与 `features/scoreConfigs/index.ts` 同模式）。
- 验证：`pnpm run typecheck`。

#### T1.4 修改 `packages/shared/src/index.ts`

- 涉及文件：`packages/shared/src/index.ts`（修改）
- 具体改动：把 :32 的 `export * from "./features/datasets/validation"` 替换为 `export * from "./features/datasets"`（经 index.ts 聚合，避免重复导出冲突）。
- 验证：`pnpm run typecheck`。

### T2 Telemetry 域：`dataset_run_items` 表 + ingestion 接线

#### T2.1 修改 `packages/shared/src/server/adapters/sqlite-telemetry-adapter.ts`

- 涉及文件：`packages/shared/src/server/adapters/sqlite-telemetry-adapter.ts`（修改）
- 具体改动：在 `initializeSchema()` 的 `CREATE TABLE IF NOT EXISTS` 段（scores 表之后，:266 附近）新增：
  - `dataset_run_items`：`id`、`project_id`、`dataset_run_id`、`dataset_item_id`、`dataset_id`、`trace_id`、`observation_id`、`error`、`created_at`、`updated_at`、`is_deleted`，`PRIMARY KEY (project_id, id)`（对齐上游 ClickHouse 的 `dataset_run_items_rmt` 形态与 `DatasetRunItemDomain` 字段）。
  - 索引：`(project_id, dataset_run_id)`、`(project_id, dataset_item_id)`、`(project_id, trace_id)`。
  - 该表加入 `mergeInsert` 的 PK 白名单（`adapter.ts:524-528` 的 `["project_id", "id"]` 三元组判断处），使 run item 更新走字段级合并（可选；若 ingestion 用 `insert` 则无需改）。
- 验证：新库与既有库（旧 `telemetry.db` 直接复用）启动后 `sqlite3 ... .tables` 均含 `dataset_run_items`。

#### T2.2 修改 `packages/shared/src/server/ingestion/processEventBatchLite.ts`

- 涉及文件：`packages/shared/src/server/ingestion/processEventBatchLite.ts`（修改）
- 具体改动：`eventToRow()` 增加 `entityType === "dataset_run_item"` 分支（:99 trace / :123 observation / :162 score 之后）：
  - 行字段：`id = body.id ?? randomUUID()`（上游语义：缺省服务端生成）、`project_id`、`dataset_run_id = body.runId`、`dataset_item_id = body.datasetItemId`、`dataset_id = body.datasetId`、`trace_id = body.traceId`、`observation_id`、`error`、`created_at/updated_at/event_ts/is_deleted`（复用 `baseRow`）。
  - `datasetVersion` 解析后仅记日志（lite 不支持按版本查询，见决策 D2）。
  - 写库路径（:319-324）`table` 联合类型扩为 `"traces" | "observations" | "scores" | "dataset_run_items"`。
  - `rowsByTable` 初始化对象（:218-222，现仅 `traces`/`observations`/`scores` 三键）需加入 `dataset_run_items: []`——否则 :249 的 `rowsByTable[result.table].push()` 对 `dataset_run_items` 为 undefined，抛 TypeError 导致整批 500。
- 验证：见 T2.3。

#### T2.3 修改 `packages/shared/src/server/ingestion/processEventBatchLite.test.ts`

- 涉及文件：`packages/shared/src/server/ingestion/processEventBatchLite.test.ts`（修改）
- 具体改动：新增用例：`dataset-run-item-create` 事件（含/不含 `id`、含 `observationId`/`error`）→ 落库 `dataset_run_items` 且字段正确；缺 `traceId`/`runId` 的事件 → 事件级 400（断言 `result.errors[0].status === 400`；HTTP 响应整体为 207，`routes/ingestion.ts:56`）。
- 验证：`pnpm --filter @peri-fuse/shared run test`。

### T3 Server：路由 + shaping

> 路由拆分决策：datasets（5 端点）、items（4 端点）、runs（3 端点）各一个路由文件，shaping 各一个文件，保证单文件 ≤ 500 行（约束）。

#### T3.1 新增 `packages/server/src/routes/datasets.ts`

- 涉及文件：`packages/server/src/routes/datasets.ts`（新增）
- 具体改动：
  - `POST /api/public/datasets`（authMiddleware）：校验 `DatasetCreateSchema` → `shaping/datasets.ts` 创建 → 200 + dataset 响应（**上游 create 端点统一 200**，对齐 fastify 默认语义，SDK 兼容优先）；`(projectId, name)` 冲突抛 409（用既有 `LangfuseConflictError`，`shared/src/errors/ConflictError.ts:3`）。
  - `GET /api/public/datasets`（authMiddleware）：`GetDatasetsQuerySchema`；支持 `name`（精确）/`id` 过滤；`{ data, meta }` 分页。
  - `GET /api/public/datasets/{datasetId}`（authMiddleware）：404（`LangfuseNotFoundError`）当不存在。
  - `PATCH /api/public/datasets/{datasetId}`：`DatasetUpdateSchema`；`name` 冲突 409。
  - `DELETE /api/public/datasets/{datasetId}`：级联（FK cascade 已定义）删除 items/runs；204 无 body。
  - 全部 GET 可挂 `responseCache(2_000)`（与 scores.ts 一致，键含 projectId 天然隔离）。
- 验证：T4.1 测试 + `pnpm run typecheck`。

#### T3.2 新增 `packages/server/src/routes/dataset-items.ts`

- 涉及文件：`packages/server/src/routes/dataset-items.ts`（新增）
- 具体改动：
  - `POST /api/public/datasets/{datasetId}/items`：body 为数组（SDK 语义），兼容单对象（`Array.isArray` 包装）；校验每项 `DatasetItemCreateSchema` → 版本化写入（D1）→ 200 + 创建后的当前版本对象数组；dataset 不存在 404。
  - `GET /api/public/datasets/{datasetId}/items`：分页 + `status` 过滤；仅当前版本（`validTo IS NULL` 且 `isDeleted = 0`）。
  - `PATCH /api/public/datasets/{datasetId}/items/{itemId}`：对当前有效版本做"关旧插新"（D1）；status 变更落新版本行；无当前版本（已删/已归档）→ 404。
  - `DELETE /api/public/datasets/{datasetId}/items/{itemId}`：软删除（当前版本行 `isDeleted=1`、`validTo=now`）→ 204。
- 验证：T4.1 测试。

#### T3.3 新增 `packages/server/src/routes/dataset-runs.ts`

- 涉及文件：`packages/server/src/routes/dataset-runs.ts`（新增）
- 具体改动：
  - `POST /api/public/datasets/{datasetId}/runs`：`DatasetRunCreateSchema`；`(datasetId, projectId, name)` 冲突 409；200 + run（同上游 200 语义）。
  - `GET /api/public/datasets/{datasetId}/runs`：分页列表，每 run 返回 `itemCount`（当前版本 items 数，对齐上游 run 列表形状）。
  - `GET /api/public/datasets/{datasetId}/runs/{runId}`：run 详情 = run 行 + `items[]`（D3 拼装，新增 `DatasetRunItemWithScores` 类型 = `DatasetRunItemSchema`（`domain/dataset-run-items.ts:5-27`，无 scores 字段）形状 + `scores[]`；item 当前版本 input/expectedOutput/metadata + `datasetItemVersion`=validFrom）。
  - 注意：run 跨"库"拼装（runs/items 在管理域，run_items/scores 在 telemetry 域），本文件只编排，查询在 shaping。
- 验证：T4.1 测试。

#### T3.4 新增 `packages/server/src/shaping/datasets.ts`

- 涉及文件：`packages/server/src/shaping/datasets.ts`（新增）
- 具体改动：`createDataset` / `getDatasetById` / `listDatasets`（+`countDatasets`）/ `updateDataset` / `deleteDataset`；drizzle 查询（`prisma.query.datasets` 或 `getDb()`），JSON 字段（`metadata`/`inputSchema`/`expectedOutputSchema`）parse-on-read（`parseJsonPrioritised`，参考 auth.ts:15）；行 → `DatasetPublicApi` 转换函数；409 冲突检测用 try/catch 唯一约束或先查后插（`prisma-compat` 无 `$transaction`/`batch`，事务须经 `getDb()`（drizzle client）的 `db.transaction()`；better-sqlite3 同步单连接下先查后插本身原子，也可省略事务）。
- 验证：`pnpm run typecheck`。

#### T3.5 新增 `packages/server/src/shaping/dataset-items.ts`

- 涉及文件：`packages/server/src/shaping/dataset-items.ts`（新增）
- 具体改动：核心版本化逻辑（D1）：
  - `createDatasetItems(projectId, datasetId, items[])`：校验 dataset 存在；逐项——已存在逻辑键 `(projectId, id)` 且当前版本有效 → 事务内 `UPDATE ... SET valid_to = now WHERE id = ? AND project_id = ? AND valid_to IS NULL`，再 INSERT 新行（`valid_from = now`）；新 id 直接 INSERT。事务经 `getDb()`（drizzle）的 `db.transaction()`（`prisma-compat` 无 `$transaction`/`batch`）；或直接省略——better-sqlite3 同步单连接下"关旧插新"两步原子。
  - `listDatasetItems`（当前版本 + status 过滤 + 分页 + count）。
  - `updateDatasetItem`（关旧插新 + 字段合并 + status 落新行）。
  - `deleteDatasetItem`（软删）。
  - JSON 字段 stringify-on-write / parse-on-read。
- 验证：T4.1 测试。

#### T3.6 新增 `packages/server/src/shaping/dataset-runs.ts`

- 涉及文件：`packages/server/src/shaping/dataset-runs.ts`（新增）
- 具体改动：
  - `createDatasetRun` / `listDatasetRuns` / `getDatasetRunById`（管理域 drizzle）。
  - `getDatasetRunItems(runId, projectId)`：telemetry 域 SQL 查 `dataset_run_items`（按 `dataset_run_id`）。
  - `getRunItemScores(projectId, traceIds)`：直接调用既有 `liteGetScoresForTraces(projectId, traceIds)`（`lite-queries.ts:800`，含空 traceIds 兜底与错误日志；**不用** `dataset_run_id`，见 D3）。
  - `assembleRunDetail(run, items, scores, itemCurrentVersions)`：items 与 scores 按 trace_id（+observation_id）聚合；item 数据取 `dataset_items` 当前版本（按 `datasetItemId` 批量查）；输出对齐 `DatasetRunItemSchema`。
- 验证：T4.1 测试。

#### T3.7 修改 `packages/server/src/app.ts`

- 涉及文件：`packages/server/src/app.ts`（修改）
- 具体改动：import 并 `app.route("/", ...)` 注册 `datasetRoutes`、`datasetItemRoutes`、`datasetRunRoutes`（:66-76 列表处）；`app.ts:44` 的 `allowMethods` 现为 `["GET","POST","PUT","DELETE","OPTIONS"]` 无 PATCH，新增 PATCH 端点后需追加 `"PATCH"`（否则浏览器跨域预检失败；Node SDK 不受影响）。
- 验证：`pnpm run typecheck`。

#### T3.8 修改 `packages/server/src/__tests__/helpers.ts`

- 涉及文件：`packages/server/src/__tests__/helpers.ts`（修改）
- 具体改动：新增 `apiPatch` / `apiDelete` helper（对齐 `apiGet`/`apiPost` 签名，helpers 文件当前 61 行，扩展后仍 < 500）。
- 验证：`pnpm run typecheck`。

### T4 测试与 E2E

#### T4.1 新增 `packages/server/src/__tests__/datasets.test.ts`

- 涉及文件：`packages/server/src/__tests__/datasets.test.ts`（新增）
- 具体改动：集成测试（`app.request()` 进程内，复用 global-setup 的测试库与 key）：
  - dataset CRUD：创建/列表/单查/更新/删除（204）；name 冲突 409；不存在 404；校验失败 400。
  - items 版本化：同 id 二次 POST → 列表仅当前版本且内容为新值（旧行 `valid_to` 已关闭，可用 `getDb()` 直查断言）；PATCH → 新版本；DELETE → 软删（列表消失、行 `is_deleted=1`）。
  - runs：POST/GET runs；`GET runs/{runId}` 拼装正确（通过 `apiPost("/api/public/ingestion", { batch: [...] })` 造 run item + trace + score——既有写法见 `ingestion-roundtrip.test.ts:27`；或直接 `getTelemetryDB().insert`，断言 items[].scores 关联正确）。
  - 项目隔离：测试内用 `prisma.insert(projects/apiKeys)` 自建第二项目 key（`global-setup.ts:47-65` 仅 seed 一个项目/key），访问 A 项目 dataset → 404/空列表；ingestion 的 run item 事件带 `project_id` 校验（跨项目 runId 的 run item 落库后不出现在本项目 run 详情）。
- 验证：`pnpm --filter @peri-fuse/server run test`。

#### T4.2 修改 `packages/server/e2e/langfuse-sdk-e2e.mjs`

- 涉及文件：`packages/server/e2e/langfuse-sdk-e2e.mjs`（修改）
- 具体改动：新增 `testDatasetsApi()`（注册进 `main()` :431-452）：
  - SDK v3：`client.datasets.createDataset({ name })` → `createDatasetItem({ datasetId, input, expectedOutput })`（同 id 两次以验证版本化）→ `createRun({ datasetId, name })` → 用 SDK 跑一个 trace + `trace.score(...)` + `client.datasets.runItems.create({ runId, datasetItemId, traceId })` → `flushAsync`。
  - REST 断言：`GET /api/public/datasets`（列表含新 dataset）、`GET .../datasets/{id}`、`GET .../items`（仅 1 个当前版本）、`GET .../runs/{runId}`（items 含 input/expectedOutput/version/scores 且 score 值正确）、`PATCH dataset` 改名成功、`DELETE item` 后列表为空、`DELETE dataset` 204。
  - 注意 SDK 版本差异：若 `datasets.runItems` 不存在，退化为直接 `api("POST", "/api/public/ingestion", ...)` 发 `dataset-run-item-create` 事件（事件 schema 已在 `types.ts` 就绪）。
- 验证：`pnpm --filter @peri-fuse/server run test:e2e`。

## 验证策略（整体）

1. 静态：`pnpm run typecheck && pnpm run lint`（全仓）。
2. 单测：`pnpm --filter @peri-fuse/shared run test`（ingestion 事件）+ `pnpm --filter @peri-fuse/server run test`（datasets 集成）。
3. 行为：`pnpm run test`（根聚合）。
4. E2E：`pnpm --filter @peri-fuse/server run test:e2e`（真 SDK 对真端口）。
5. 手工冒烟（可选）：`PERIFUSE_HOME=/tmp/pf-phase2 pnpm dev:server` 后 `curl` 全流程。

## 风险与决策点

- **D1（版本化写入语义）**：POST/PATCH item 采用"关旧插新"（先 `UPDATE valid_to = now` 当前有效行，再 INSERT `valid_from = now` 新行）；GET 只取 `valid_to IS NULL AND is_deleted = 0`。与上游 langfuse 一致（`datasetItemVersion` 即 validFrom 的体现）。决策：不做时间点查询（`datasetVersion` 参数忽略，仅日志），lite 无此需求。
- **D2（`dataset_run_items` 表归属）**：放 **telemetry DB**（`initializeSchema()` 无条件 `CREATE TABLE IF NOT EXISTS`，新库/既有库自动生效），不新增 drizzle 迁移 —— 因为 `ensureSchema()`（client.ts:117-130）对既有库跳过全部迁移，新增管理域表会破坏既有安装；且 run items 需与 traces/scores 同库 JOIN（上游也是"runs 在 PG、run items 在 ClickHouse"的跨库架构，lite 以双库同构复刻）。
- **D3（run 关联 score 的方式）**：lite `scores` 表无 `dataset_run_id` 列（:245-266），Phase 2 **不新增该列**，run 详情 scores 通过 `scores.trace_id = dataset_run_items.trace_id` JOIN（对齐上游 `getTraceScoresForDatasetRuns`，`repositories/scores.ts:335-399`）。SDK experiments 的打分路径是 `trace.score()`（traceId 关联），已兼容。`datasetRunId` 独占的 score 事件（上游 eval runner 用）当前会被 lite 以 `trace_id NOT NULL` 约束写失败 —— 既有行为，归入后续增强评估（决策点，不在本阶段修复）。
- **R1（409 语义）**：dataset 同名创建、run 同名创建、dataset 改名冲突 → 409。用"先查后插 + 唯一索引兜底"（better-sqlite3 同步单连接无竞态）。使用既有 `LangfuseConflictError`（`shared/src/errors/ConflictError.ts:3`，httpCode 409）；400 系保留 `InvalidRequestError` 习惯。
- **R2（PATCH 已归档 item）**：无当前有效版本（已删除/已归档）时 PATCH/DELETE → 404（对齐上游"操作当前版本"语义）。归档后再 PATCH 需先恢复 status —— 简化：404 + 提示信息，不做自动恢复。
- **R3（缓存）**：GET 列表/详情挂 `responseCache(2_000)`；写后 2 秒内读可能陈旧 —— 与 scores 端点现状一致，可接受；不需要为 datasets 单独调优。
- **R4（分页上限）**：`limit` 默认 50、最大 500（对齐 users.ts）；`meta.totalItems/totalPages` 语义同 scores.ts。
- **R5（items POST 兼容性）**：body 数组为主（上游/SDK 语义），单对象兼容包装。SDK 兼容测试覆盖数组路径。
- **R6（范围外）**：`datasetItemMedia`（无文件上传）、`remoteExperiment*` 仅存储不执行、`datasetVersion` 时间点查询、dataset run 执行/调度（明确由 SDK 客户端驱动，Phase 2 只做元数据与查询）、`dataset_run_items` 孤儿行（删除 dataset 不清理——telemetry 域无 FK 机制；孤儿行无 API 可达，可接受）。
- **R7（文件行数）**：路由与 shaping 按 T3 拆分三个文件对，任何单文件超 500 行时再横向拆分（如 shaping 拆 runs 详情拼装为独立文件），禁止堆行。
