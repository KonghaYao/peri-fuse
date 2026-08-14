# Phase 4: Web UI + Annotation Queues

## 目标

一句话：打通 annotation queues 全链路（server API + 域逻辑 + web 队列管理/标注打分），并新增 evals、datasets、annotation queues 三个 web 页面与导航入口。

可验收标准：

- A1：`/api/public/annotation-queues` 系列端点（队列 CRUD + items CRUD + assignments）可用，全部按 `projectId` 隔离（跨项目访问返回 404，测试覆盖）。
- A2：web 侧边栏出现 Evals / Datasets / Annotation queues 三个新入口，路由可达、页面可渲染。
- A3：annotation 队列详情页可对 item 打分，提交的分数以 `source=ANNOTATION` 出现在 `GET /api/public/scores` 与 Scores 页面。
- A4：evals 页面可列出/新建/编辑 eval config，并可查看运行记录（job_executions 只读）。
- A5：datasets 页面可列出 dataset 并查看其 items（含 input/expectedOutput 渲染）。
- A6：`pnpm run typecheck && pnpm run lint && pnpm run test` 通过；server 新增 annotation-queues 集成测试；`pnpm --filter @peri-fuse/web run build` 通过。

## 前置依赖

- Phase 1–3 已完成：ingestion 写库（`processEventBatchLite.ts`，支持 score 事件）、基础 public API（traces/observations/scores/sessions/users/dashboard）、scoreConfigs 域逻辑（`shared/src/features/scoreConfigs/`）。
- DB schema 就绪：`annotation_queues`（schema.ts:339）、`annotation_queue_items`（schema.ts:354）、`annotation_queue_assignments`（schema.ts:376）、`datasets`/`dataset_items`/`dataset_runs`（schema.ts:395/416/448）、`eval_templates`/`job_configurations`/`job_executions`（schema.ts:641/664/687）。类型已导出（`shared/src/db/types.ts:105-107`：`AnnotationQueue`/`AnnotationQueueItem`/`AnnotationQueueAssignment`）。
- **API 归属**：score-configs / eval-configs / eval-templates 路由与 `POST /api/public/scores` 已由 [phase-1-api-compat.md](./phase-1-api-compat.md) 交付（T3/T5/T6/T4），datasets / items 路由已由 [phase-2-datasets.md](./phase-2-datasets.md) 交付（T3.1/T3.2）——本阶段直接复用，不再实现；annotation-queues 路由 server 端尚不存在，为本阶段新增（范围决策见"风险与决策点"D1/D2/D3）。

## 现状

### server 端事实

- 路由注册：`packages/server/src/app.ts:66-76`（`app.route("/", xxxRoutes)` 模式），当前只有 ingestion/otel/traces/observations/scores/sessions/users/dashboard/manage/health/gateway-proxy。
- 认证：`packages/server/src/auth.ts` 的 `authMiddleware`，`c.get("auth").scope.projectId` 为当前项目（routes/scores.ts:16-17 用法）。
- GET 路由范式：`routes/scores.ts` —— zod 解析 query → 域函数取数 → `{ data, meta: { page, limit, totalItems, totalPages } }`，列表端点挂 `responseCache(2_000)`。
- 写库范式：drizzle 封装 `prisma`（`@peri-fuse/shared/src/db`），`prisma.query.X.findFirst` / `prisma.insert(X)` / `prisma.update(X)`（见 auth.ts:83、manage.ts:10）；错误映射 `PrismaClientKnownRequestError`（P2002/P2025，`prisma-compat.ts:29-55`）。
- lite 模式无真实 users 表数据：`routes/users.ts:4-10` 从 `traces.user_id` 聚合派生用户列表。
- `features/annotation/types.ts` 已有 zod：`CreateQueueData`（name≤35/description≤1000/scoreConfigIds≥1）、`CreateQueueWithAssignmentsData`、`CreateAnnotationScoreData`/`UpdateAnnotationScoreData`（含 Boolean 派生 value 的 transform）。
- 打分写入通道：`POST /api/public/scores` 由 phase-1 T4 接线（`routes/scores.ts` 新增 POST 分支，复用 `validateAndInflateScore.ts:28` Central choke point）；ingestion 已支持 score 事件（`processEventBatchLite.ts`）。

### web 端事实

- 路由：`packages/web/src/App.tsx` —— lazy import + `<Route path="..." element={<RequireProject><Suspense fallback={<PageFallback/>}>…`（模式见 App.tsx:8-63、114-253），`*` 兜底重定向。
- 导航：`packages/web/src/shared/components/layout.tsx:41-48` 的 `navItems` 数组（Dashboard/Traces/Sessions/Users/Observations/Scores）。
- API 层：`packages/web/src/shared/lib/api.ts` —— `request<T>(path)` 仅 GET（api.ts:66-99，Basic auth + 401 清 context）；`manageRequest` 支持任意 method（api.ts:155-171）。**写方法需扩展 `request`**。
- Query 层：`packages/web/src/shared/hooks/queries.ts` —— `queryKeys` 工厂（queries.ts:42-54）+ 每资源 `useXxxQuery`（`keepPreviousData` + `refetchInterval`）+ mutation 后 `invalidateQueries`（queries.ts:166-194）。
- 列表页范式：`features/scores/scores-page.tsx` —— `useTableState`（URL 同步分页/排序/过滤）+ `useXxxQuery` + `PageHeader` / `FilterInput` / `Pagination` / `EmptyState` / `ErrorState` / `LoadingRows` / `Badge` / `Table`。
- 类型：`packages/web/src/shared/lib/types.ts` 集中定义 `Paged<T>`（types.ts:16）与各资源类型/参数类型。
- 打分 UI 参考：scores feature 只有列表页（`features/scores/` 无表单），打分表单需新写，交互参考上游 annotation queue detail（按 scoreConfig dataType 渲染 numeric/categorical/boolean/text）。
- 测试：`packages/server/src/__tests__/helpers.ts` 提供 `apiGet`/`apiPost`（`app.request` 直调，无需端口）；**缺 `apiPatch`/`apiDelete`**。

## 任务清单

### T0 前置：web API 层支持写方法

#### T0.1 扩展 `request` 支持 method + body

- 涉及文件：`packages/web/src/shared/lib/api.ts`
- 具体改动：`request<T>(path, init?: { method?: "GET"|"POST"|"PATCH"|"DELETE"; body?: unknown })`，默认 GET；`body` 存在时 `JSON.stringify` 并保持 `Content-Type`；错误解析与 401 清 context 逻辑不变（向后兼容现有调用）。
- 验证：`pnpm run typecheck`；现有页面（traces/scores 等）行为不变。

### T1 server：annotation queues API + 域逻辑（核心）

#### T1.1 补全 shared 域逻辑 `features/annotation`

- 涉及文件：
  - 修改 `packages/shared/src/features/annotation/types.ts`（补 zod schema）
  - 新增 `packages/shared/src/features/annotation/queues.ts`（队列 + assignments 服务）
  - 新增 `packages/shared/src/features/annotation/queueItems.ts`（items 服务，若 queues.ts 超 500 行）
  - 新增 `packages/shared/src/features/annotation/index.ts`（`export *`）
- 具体改动：
  - types.ts 追加：`UpdateQueueData`（`CreateQueueData` 全字段 optional）、`QueueStatus`（直接复用已导出的 `AnnotationQueueStatus`（prisma-enums.ts:60，PENDING/COMPLETED，db.ts:33 已导出），对应 schema.ts:359 默认值，避免两处定义漂移）、`CreateQueueItemData`（`objectId`、`objectType` 基于 `AnnotationQueueObjectType`（prisma-enums.ts:64）收窄为 `z.enum(["trace"])`，lite 先只支持 trace，见 D5）、`UpdateQueueItemData`（`status`/`lockedAt`/`lockedByUserId`/`completedAt`/`annotatorUserId` 可选）。
  - queues.ts：`listQueues(projectId, page, limit)`、`getQueue(projectId, queueId)`、`createQueue(projectId, data)`、`updateQueue(projectId, queueId, data)`、`deleteQueue(projectId, queueId)`、`listAssignments(projectId, queueId)`、`upsertAssignments(projectId, queueId, userIds)`、`deleteAssignment(projectId, queueId, assignmentId)`。要点：全部按 `projectId` 过滤；`scoreConfigIds` 存 TEXT JSON（schema.ts:343，`JSON.stringify`/`parse`）；创建时校验 `scoreConfigIds` 均属于该 project（`scoreConfigs` 表 `inArray`）；删除走 FK cascade（schema.ts:356/380）；not-found 抛 `LangfuseNotFoundError`（app.ts:53 全局映射 404）；唯一冲突（P2002）需域服务内自行 try/catch —— `toKnownRequestError`（prisma-compat.ts:46）识别后抛 `LangfuseConflictError`（httpCode 409，先例 TableViewService.ts:50-53），app.ts onError 只映射 BaseError 子类，不会自动处理 P2002。
  - queueItems.ts：`listQueueItems(projectId, queueId, {page, limit, status})`（排序 `createdAt.desc`）、`createQueueItem`（校验 objectId 对应 trace 存在且属于该 project：traces 表在 telemetry 库（`sqlite-telemetry-adapter.ts:128`），metadata 库 schema 无该表，须经 `liteGetTraceById(projectId, traceId)`（repositories/lite-queries.ts:427，按 projectId+id）跨库校验，见 D5）、`updateQueueItem`（status 流转：COMPLETED 时写 `completedAt`）、`deleteQueueItem`。
- 验证：`pnpm run typecheck`；后续 T1.3 集成测试覆盖。

#### T1.2 server 路由

- 涉及文件：
  - 新增 `packages/server/src/routes/annotation-queues.ts`（集合 + queue + assignments；若超 500 行拆 `annotation-queue-items.ts` 挂子路由）
  - 修改 `packages/server/src/app.ts`（在 66-76 区域注册 `app.route("/", annotationQueueRoutes)`）
- 具体改动（全部 `authMiddleware`，`projectId = c.get("auth").scope.projectId`）：
  - `GET /api/public/annotation-queues`：分页 + `responseCache(2_000)`，返回 `{ data, meta }`（对齐 scores.ts 形状）。
  - `POST /api/public/annotation-queues`：zod 解析（复用 T1.1 schema），400 返回 `{ message, error }`。
  - `GET|PATCH|DELETE /api/public/annotation-queues/{queueId}`：PATCH 支持部分更新；DELETE 返回 `{ success: true }`（JSON —— web `request` 以 `res.json()` 收尾（api.ts:98），204 空 body 会抛 SyntaxError；对齐 manage.ts:165 先例）。
  - `GET|POST /api/public/annotation-queues/{queueId}/items`：GET 分页 + `status` 过滤；POST 创建 item。
  - `PATCH|DELETE /api/public/annotation-queues/{queueId}/items/{itemId}`。
  - `GET /api/public/annotation-queues/{queueId}/assignments`（可选 `?userId=` 过滤）、`POST …/assignments`（`{ userIds: string[] }` 批量 upsert）、`DELETE …/assignments/{assignmentId}`。
- 验证：`pnpm run typecheck && pnpm run lint`。

#### T1.3 集成测试

- 涉及文件：
  - 修改 `packages/server/src/__tests__/helpers.ts`：新增 `apiPatch`/`apiDelete`（照 `apiGet`/`apiPost` 模式，helpers.ts:33-60）。
  - 新增 `packages/server/src/__tests__/annotation-queues.test.ts`（vitest 默认只收集 `*.test.ts`（vitest.config.ts 无自定义 include），不带后缀的文件不会被运行）。
- 具体改动：测试用例 —— ① 创建队列（含 scoreConfigIds 校验失败 400）；② 队列列表分页；③ PATCH 改名；④ 添加 item（objectType=trace，先经 `apiPost("/api/public/ingestion", { batch: [...] })` 造 trace）；⑤ 更新 item 状态为 COMPLETED；⑥ assignments upsert/删除（先经 prisma 造真实 users 行 —— metadata 库强制 `foreign_keys = ON`（db/client.ts:41），userId 有 FK 到 users（schema.ts:379），见 D4）；⑦ DELETE 队列级联清理 items/assignments；⑧ **项目隔离**：用 B 项目 key 访问 A 项目队列/items 返回 404；⑨ 未认证请求 401。
- 验证：`pnpm --filter @peri-fuse/server run test`。

#### T1.4 复用 POST /api/public/scores（依赖 phase-1 T4 交付）

- 具体改动：`POST /api/public/scores` 已在 phase-1 T4 接线（`routes/scores.ts` 新增 POST 分支，复用 `validateAndInflateScore` 校验、经 `processEventBatchLite` 落 telemetry 库），本阶段**不重复实现**；T5.2 打分表单与 T1.3 集成测试直接调用该端点（`source=ANNOTATION`）。
- 补充测试（可选）：在 T1.3 的 `annotation-queues.test.ts` 中追加 ANNOTATION 打分流（含 boolean value 派生、无效 config 400）——基础用例已由 phase-1 T7 的 `scores-post.test.ts` 覆盖。
- 验证：`pnpm --filter @peri-fuse/server run test`；Scores 页可见 ANNOTATION 分数。

### T2 前序阶段 API 复用（P1/P2 已交付，本阶段无新增实现）

> 下表 API 均已由前序阶段交付（phase-1 T3/T5、phase-2 T3.1），本阶段直接复用；仅 T2.2 的 `{id}/runs` 只读端点为新增（数据由 P3 引擎产生）。

#### T2.1 score-configs API（复用 phase-1 T3 交付）

- 具体改动：`GET /api/public/score-configs`（S1，`authMiddleware` + `responseCache(2_000)`，按 projectId 过滤）与 S2-S4 已由 phase-1 T3 交付（`routes/score-configs.ts`），本阶段**不重复实现**；T5.1 队列创建时的 scoreConfigIds 多选直接使用该端点。
- 验证：`pnpm run typecheck`；T5 手动验证选择器可用。

#### T2.2 eval-configs API（复用 phase-1 T5 交付 + 新增 runs 只读端点）

- 具体改动：
  - eval configs CRUD 已由 phase-1 T5 交付（`routes/evals.ts`，E1-E10：`GET/POST /api/public/evals` 与详情/更新/删除别名，按决策点 D1 默认直读写 `job_configurations`），本阶段**不重复实现**；T3 web 页面直接使用。
  - **新增** `GET /api/public/evals/{configId}/runs`（在 `routes/evals.ts` 追加，或并入 T3.2）：`job_executions` 按 `jobConfigurationId` 分页（status/startTime/endTime/error），数据由 P3 引擎产生——phase-1 契约 E1-E10 不含 runs 端点，属本阶段增量。
- 验证：`pnpm run typecheck`；A4 手动验收。

#### T2.3 datasets API（复用 phase-2 T3.1 交付）

- 具体改动：datasets / items / runs 端点已由 phase-2 T3.1-T3.3 交付（`routes/datasets.ts` / `dataset-items.ts` / `dataset-runs.ts`，CRUD + 分页），本阶段**不重复实现**；T4 web 页面直接使用（`GET /api/public/datasets`、`GET /api/public/datasets/{id}`，items 走 `GET /api/public/datasets/{datasetId}/items`）。
- 验证：`pnpm run typecheck`；A5 手动验收。

### T3 web：evals 页面（依赖 phase-1 T5/T6 的 API + T2.2 runs 端点）

#### T3.1 列表页 + 新建/编辑

- 涉及文件：
  - 新增 `packages/web/src/features/evals/evals-page.tsx`
  - 新增 `packages/web/src/features/evals/components/eval-config-dialog.tsx`
- 具体改动：列表页照 scores-page 范式（`useTableState` + `useEvalConfigsQuery`，列：scoreName/targetObject/status/sampling/updatedAt）；dialog 表单字段对应 phase-1 T5（E1-E10 契约）的 eval-configs 字段，提交走 mutation。
- 验证：`pnpm --filter @peri-fuse/web run build`；A4。

#### T3.2 运行记录查看

- 涉及文件：新增 `packages/web/src/features/evals/eval-config-runs-view.tsx`（或并入 evals-page 的 tab）
- 具体改动：选中 config 后展示 `job_executions` 列表（status/startTime/endTime/error，error 截断显示），只读；数据走 T2.2 的 `GET /api/public/evals/{configId}/runs`。
- 验证：A4 手动验收（有 job_executions 数据时可见）。

#### T3.3 类型与请求层

- 涉及文件：修改 `packages/web/src/shared/lib/types.ts`、`packages/web/src/shared/lib/api.ts`、`packages/web/src/shared/hooks/queries.ts`
- 具体改动：types.ts 增加 `EvalConfig`/`EvalConfigListParams`/`EvalRun`；api.ts 增加 `listEvalConfigs`/`createEvalConfig`/`updateEvalConfig`/`listEvalRuns`（写方法走 T0.1）；queries.ts 增加 `queryKeys.evalConfigs/evalRuns` 与对应 hooks/mutations（mutation 成功后 invalidate 列表 key）。
- 验证：`pnpm run typecheck`。

### T4 web：datasets 页面（依赖 phase-2 T3.1/T3.2 的 datasets API）

#### T4.1 列表页

- 涉及文件：新增 `packages/web/src/features/datasets/datasets-page.tsx`
- 具体改动：scores-page 范式列表（列：name/description/items 计数（可选）/updatedAt），行点击进详情。
- 验证：`pnpm --filter @peri-fuse/web run build`。

#### T4.2 详情页（items 查看）

- 涉及文件：新增 `packages/web/src/features/datasets/dataset-detail-page.tsx`
- 具体改动：`useDatasetQuery` 拉详情 + items 分页；每条 item 渲染 input/expectedOutput（复用 `shared/components/json-viewer.tsx` 或 `io-viewer.tsx`），metadata 折叠展示。
- 验证：A5 手动验收。

#### T4.3 类型与请求层

- 涉及文件：修改 `packages/web/src/shared/lib/types.ts`、`api.ts`、`queries.ts`
- 具体改动：types.ts 增加 `Dataset`/`DatasetItem`/`DatasetDetail`；api.ts 增加 `listDatasets`/`getDataset`；queries.ts 增加 `queryKeys.datasets/dataset` 与 `useDatasetsQuery`/`useDatasetQuery`。
- 验证：`pnpm run typecheck`。

### T5 web：annotation queues 页面（依赖 T1 + phase-1 T3 的 score-configs API + T0.1）

#### T5.1 队列列表页 + 新建

- 涉及文件：新增 `packages/web/src/features/annotation-queues/annotation-queues-page.tsx`
- 具体改动：scores-page 范式列表（列：name/description/scoreConfigIds 数量/updatedAt）；新建 dialog：name/description + scoreConfigs 多选（数据来自 phase-1 T3 交付的 `GET /api/public/score-configs`，提交 `CreateQueueData`）。
- 验证：`pnpm --filter @peri-fuse/web run build`。

#### T5.2 队列详情页（items + 打分交互）

- 涉及文件：
  - 新增 `packages/web/src/features/annotation-queues/annotation-queue-detail-page.tsx`
  - 新增 `packages/web/src/features/annotation-queues/components/queue-item-score-form.tsx`
  - 新增 `packages/web/src/features/annotation-queues/components/add-item-dialog.tsx`
- 具体改动：
  - 详情页：队列元信息 + `useQueueItemsQuery` 分页列表（status badge、trace 链接——复用 scores-page 的 trace link 模式，scores-page.tsx:145-153；PENDING 行显示"打分"按钮）。
  - add-item-dialog：输入 traceId（校验存在性由 T1.1 服务端兜底），POST item。
  - queue-item-score-form：按 item 所属 queue 的 scoreConfigs 渲染表单 —— NUMERIC（min/max 区间输入）、CATEGORICAL（选项单选）、BOOLEAN（True/False 单选）、TEXT（textarea），含 comment；提交时 `useCreateAnnotationScoreMutation`（POST /api/public/scores，phase-1 T4 交付）+ PATCH item `status=COMPLETED`（mutation 链：先打分别后置完成，失败回滚提示）。
- 验证：A3 手动验收（Scores 页可见 ANNOTATION 分数 + 详情页状态流转）。

#### T5.3 类型与请求层

- 涉及文件：修改 `packages/web/src/shared/lib/types.ts`、`api.ts`、`queries.ts`
- 具体改动：types.ts 增加 `AnnotationQueue`/`AnnotationQueueItem`/`AnnotationQueueListParams`/`QueueItemListParams`；api.ts 增加 `listAnnotationQueues`/`createAnnotationQueue`/`getAnnotationQueue`/`updateAnnotationQueue`/`deleteAnnotationQueue`/`listQueueItems`/`createQueueItem`/`updateQueueItem`/`deleteQueueItem`/`listScoreConfigs`/`createAnnotationScore`；queries.ts 增加对应 `queryKeys` + hooks + mutations（invalidate 关联 key：打分成功后同时 invalidate `scores` 与 `queueItems`）。
- 验证：`pnpm run typecheck`。

### T6 导航接入

#### T6.1 路由注册

- 涉及文件：修改 `packages/web/src/App.tsx`
- 具体改动：照 App.tsx:8-63 lazy import 模式新增 5 个页面（evals（runs 视图并入 evals 页，见 T3.2）、datasets、dataset detail、annotation-queues、annotation-queue detail）；照 114-253 模式注册对应 5 个 `<Route>`：`<Route path="evals">`、`<Route path="datasets">`、`<Route path="datasets/:datasetId">`、`<Route path="annotation-queues">`、`<Route path="annotation-queues/:queueId">`（均包 `RequireProject` + `Suspense`）。
- 验证：`pnpm --filter @peri-fuse/web run build`；手动点导航可达。

#### T6.2 侧边栏入口

- 涉及文件：修改 `packages/web/src/shared/components/layout.tsx`
- 具体改动：`navItems`（layout.tsx:41-48）追加 `{ to: "/evals", label: "Evals" }`、`{ to: "/datasets", label: "Datasets" }`、`{ to: "/annotation-queues", label: "Annotation Queues" }`（图标从 lucide-react 选，如 `FlaskConical`/`Database`/`ClipboardCheck`，按现有 import 风格加入）。
- 验证：A2。

## 验证策略（整体）

1. 静态：`pnpm run typecheck && pnpm run lint`（根）。
2. 单测/集成：`pnpm --filter @peri-fuse/server run test` —— 新增 `annotation-queues.test.ts`（T1.3）必须含项目隔离用例（A1），并在其中追加 ANNOTATION 打分流（A3 的服务端半边，走 phase-1 T4 交付的 POST /api/public/scores；基础用例见 phase-1 T7 的 `scores-post.test.ts`）。
3. Web 构建：`pnpm --filter @peri-fuse/web run build`（类型 + 打包）。
4. 手动验收（dev 模式）：建 score config → 建队列 → 添加 trace item → 打分 → 校验 Scores 页出现 ANNOTATION 分数且 item 变 COMPLETED（A3）；eval config 增删改 + 运行记录展示（A4）；dataset 详情 items 渲染（A5）；三入口导航（A2）。
5. 可选 E2E 扩展：`packages/server/e2e/langfuse-sdk-e2e.mjs` 追加 annotationQueues SDK 冒烟（队列创建 + 列表），仅当 SDK 类型支持时做，不作为本阶段硬性门槛。

## 风险与决策点

- **D1（已定，API 归属）**：evals / datasets 的 server API 已由前序阶段交付——eval-configs 由 phase-1 T5（E1-E10，按决策点 D1 默认直读写 `job_configurations`）、datasets 由 phase-2 T3.1-T3.3 交付；本阶段仅新增 `eval-configs/{id}/runs` 只读端点（T2.2），T3/T4 页面直接依赖既有 API，无需 mock。
- **D2（已定，写入通道）**：annotation 打分走 `POST /api/public/scores`——该端点已由 phase-1 T4 接线（复用 `validateAndInflateScore.ts:28` Central choke point），本阶段直接复用（T1.4 仅作测试补充）；备选：UI 走 ingestion score 事件（`processEventBatchLite.ts` 已支持），但与上游 UI 语义不符且无法拿返回的 score。
- **D3（已定，score-configs 来源）**：队列创建需 scoreConfigIds 多选，直接使用 phase-1 T3 交付的 `GET /api/public/score-configs`（S1，`responseCache(2_000)` 按 projectId 过滤），无需本阶段新增端点。
- **D4（user 模型）**：lite 模式无真实 users 表（users 由 `traces.user_id` 派生，routes/users.ts:4-10），但 assignments/items 的 userId 有 FK 到 users 表（schema.ts:361-362/379），且 metadata 库强制 `foreign_keys = ON`（db/client.ts:41）—— 插入不存在的 userId 会直接抛 `FOREIGN KEY constraint failed`（500），"自由文本不校验"不可行。**推荐**：lite 简化 —— assignments 为可选能力，UI 不强制分配；若做，分配/写 annotator 前先 upsert users 行（`prisma.insert(users)`，key 即 userId），或建队列/分配时同步写 users 表。
- **D5（范围简化）**：queue items 的 `objectType` 仅支持 `"trace"`（上游还支持 observation）；datasets 详情路径参数用 `id` 而非上游的 `name`。均为已知偏离，web 内部使用无 SDK 兼容压力，后续可补。补充：metadata 库无 trace 引用 FK（objectId 为自由文本），T1.1 的 trace 存在性校验仅应用层（telemetry 库 `liteGetTraceById`），不做 DB 级约束。
- **D6（500 行约束）**：annotation 路由/域服务若超限，按 T1.1/T1.2 已预留的拆分点拆文件；`annotation_queues.scoreConfigIds` 为 TEXT JSON（schema.ts:343），读写必须 `JSON.parse/stringify`，勿存对象字面量。
- **D7（mutation 顺序）**：打分 + 置 COMPLETED 的提交顺序（先 POST score 成功再 PATCH item），失败时状态回滚提示，避免"已打分但 item 仍 PENDING"或反向不一致。
