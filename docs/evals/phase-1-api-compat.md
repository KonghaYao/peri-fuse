# Phase 1: API 兼容层（Evals / Score Configs / Scores 公共 API）

> 本计划覆盖：eval configs CRUD、eval templates CRUD、score configs CRUD、POST /api/public/scores 接线、
> features/evals stub 替换、eval_configs 表迁移、e2e 扩展。
> 全部契约基于 2026-08-14 抓取的官方 OpenAPI spec（`cloud.langfuse.com/generated/api/openapi.yml`、apis.io Langfuse ScoreConfigs API）
> 与 langfuse 主仓库 `main` 分支代码。**凡标注【契约待确认】处，官方无稳定契约，按本计划拟定的形状实现并留 TODO 对齐。**

## 1. 目标（一句话 + 可验收标准）

一句话：让 lite server 的 `/api/public/*` 与上游 Langfuse 公共 API 在 score configs / scores 写入 / evals 三个面完全兼容，
所有资源按 projectId 隔离，零新增外部基础设施。

可验收标准（全部通过即完成）：
- [ ] `pnpm run typecheck && pnpm run lint && pnpm run test` 全绿；`pnpm --filter @peri-fuse/server run test:e2e` 全绿
- [ ] score-configs 四端点（GET/POST 列表、GET/PATCH by id）与上游契约一致（见 §4.1），响应字段逐一匹配
- [ ] `POST /api/public/scores` 响应码与官方契约一致（200 + `{id}` 或 204，待复核，见 §4.2），同 id 重发为 upsert 覆盖；configId 不存在返回 404，校验失败返回 400
- [ ] eval configs / eval templates CRUD 可用（§4.3、§4.4 拟契约），同 name 递增 version
- [ ] 新增 `eval_configs` 表通过 drizzle 迁移落地（按 §7 D1 已定方案：默认 B 不建表、API 直读写 `job_configurations`；若拍板选 A 才迁移建表），**对既有数据库（已存在 organizations 表）也能增量应用**
- [ ] features/evals 两个 stub 文件不再含 "not available in lite mode" 注释，改为真实类型
- [ ] e2e 新增 score-configs / POST scores / evals 三个 section

## 2. 前置依赖

- 无阶段依赖（Phase 1 为第一阶段）。依赖既有基础设施：`authMiddleware`（`packages/server/src/auth.ts:176-193`，Basic auth → `c.get("auth").scope.projectId`）、
  `responseCache`（`packages/server/src/response-cache.ts`，仅 GET、按 projectId 隔离）、全局错误映射（`app.ts:52-64`，`LangfuseNotFoundError` → 404）。

## 3. 现状（已核实的代码事实）

- 认证/注册：`packages/server/src/app.ts:66-76` 逐个 `app.route("/", xxxRoutes)`；`app.ts:44` CORS `allowMethods` **缺 PATCH**（浏览器端 PATCH 会被预检拦截，需修）。
- score-configs 领域层较完整：`packages/shared/src/features/scoreConfigs/`（index.ts 仅转发 validation.ts）；`packages/shared/src/domain/score-configs.ts:5-96`
  已有 `ScoreConfigCategory`、`ScoreConfigNameSchema`（≤35 字符）、`NumericConfigFields`/`BooleanConfigFields`/`CategoricalConfigFields`/`TextConfigFields`
  联动校验、`ScoreConfigSchema`（116-135 行）。缺：Create/Update 请求 schema（含 categories 与 dataType 联动、isArchived 更新）。
- POST /api/public/scores 接线函数可复用但**当前未被调用**：`packages/shared/src/server/ingestion/validateAndInflateScore.ts:25-81` 注释 "Central choke point"
  描述的是上游 worker 流程（lite 模式无 worker、该函数零调用），它查 `score_configs` 并抛 `InvalidRequestError`/`LangfuseNotFoundError`，
  是 configId→404 语义的唯一来源，T4 需显式接入（见 §4.2）；`processEventBatchLite.ts:162-183` 有 score 事件 → `scores` 表行映射
  （telemetry DB，非 metadata DB，直写 `config_id` 不做存在性校验）。
- 表：`score_configs`（`schema.ts:316-337`）、`eval_templates`（`schema.ts:641-662`，projectId 可空 = 全局模板，unique(projectId,name,version)）、
  `job_configurations`（`schema.ts:664-685`，EVAL 类型 config：scoreName/filter/targetObject/variableMapping/sampling/delay/timeScope/evalTemplateId）、
  `job_executions`（`schema.ts:687-710`）。类型已导出：`packages/shared/src/db/types.ts:104/122/123/172/181/182`。
- **`eval_configs` 表不存在**：本仓库 `prisma/schema.prisma`、`schema.sqlite.prisma` 均无 EvalConfig model（grep 确认）；
  **langfuse 上游 main 分支 `packages/shared/prisma/schema.prisma`（1771 行）同样没有 EvalConfig model**——上游 evals 实体就是
  `eval_templates` + `job_configurations` + `job_executions`。与 README 盘点结论一致，见 §7 决策点 D1。
- **官方没有 `/api/public/evals*` 稳定端点**：cloud openapi.yml 仅含 `/api/public/score-configs` 与 `/api/public/unstable/evaluators`、`/api/public/unstable/evaluation-rules`；
  langfuse `web/src/pages/api/public/` 目录无 evals/；eval templates 无公开 API（上游 discussion #11754 确认）。§4.3/4.4 契约均为拟契约。
- 迁移机制：`packages/shared/drizzle/` 只有 `0000_free_bucky.sql` + `meta/`（`_journal.json`、`0000_snapshot.json`）；`drizzle.config.ts`（out: ./drizzle，schema: src/db/schema/index.ts）；
  生成命令 `pnpm --filter @peri-fuse/shared db:generate`（= drizzle-kit generate）。
- **`ensureSchema()` 不支持增量迁移**：`packages/shared/src/db/client.ts:101-130` 以"organizations 表存在"为幂等判断，存在即整体跳过——
  新增的 0001 迁移 SQL 永远不会应用到既有库。**必须修复**（§7 风险 R1）。
- 路由模式参照：`routes/scores.ts`（zod safeParse → 400 `{message, error: issues}`；`meta:{page,limit,totalItems,totalPages}`，59-69 行）、
  `routes/traces.ts:33`（responseCache(2_000)）、`routes/ingestion.ts:27`（POST + BaseError 映射）。
- 测试基建：`packages/server/src/__tests__/helpers.ts:33-58`（apiGet/apiPost，直接打 `getApp().request`）；`packages/server/e2e/langfuse-sdk-e2e.mjs`
  （raw fetch 版 `api()` + 官方 langfuse SDK，现覆盖 trace/score/sessions/users/dashboard，无 score-configs/evals）；`pnpm --filter @peri-fuse/server run test:e2e` = `node e2e/run.mjs`。
- 单文件 ≤500 行约束：每路由文件一个资源，shaping 独立成文件。

## 4. 端点契约

### 4.1 Score Configs（✅ 官方契约已确认）

| # | 方法/路径 | 请求 | 响应 | 错误 |
|---|-----------|------|------|------|
| S1 | `GET /api/public/score-configs` | query: `page`(int, 默认 1), `limit`(int, 默认 50) | 200 `{data: ScoreConfig[], meta:{page,limit,totalItems,totalPages}}` | 400/401/403/405 |
| S2 | `POST /api/public/score-configs` | body `CreateScoreConfigRequest`（见下） | 200 `ScoreConfig` | 400/401/403/404/405 |
| S3 | `GET /api/public/score-configs/{configId}` | — | 200 `ScoreConfig` | 400/401/403/**404**/405 |
| S4 | `PATCH /api/public/score-configs/{configId}` | body `UpdateScoreConfigRequest`（见下） | 200 `ScoreConfig` | 400/401/403/**404**/405 |

**CreateScoreConfigRequest**（name、dataType 必填）：`name` string ≤35（字母数字 `_` 空格 `.` `()` `-`）；`dataType` enum `NUMERIC|BOOLEAN|CATEGORICAL|TEXT`；
`categories?` `[{value: number, label: string}]`（CATEGORICAL 必传；BOOLEAN 必传且须精确为 `[True/1, False/0]`，复用既有 `BooleanConfigFields`
（domain/score-configs.ts:29-47）语义；NUMERIC/TEXT 不可传）；`minValue?`/`maxValue?` number（仅 NUMERIC；min ≤ max）；
`description?` string。
**UpdateScoreConfigRequest**（全可选）：`isArchived?` bool、`name?`、`categories?`、`minValue?`、`maxValue?`、`description?`。
**ScoreConfig 响应**：`id, name, createdAt, updatedAt, projectId, dataType, isArchived, minValue?, maxValue?, categories?, description?`（createdAt/updatedAt 为 ISO 字符串）。
**注意：上游无 DELETE score-configs 端点**（config 不可删，只能 PATCH `isArchived: true` 归档）——本阶段不实现 DELETE，与"CRUD"措辞的差异见 §7 D2。
分页语义与 `routes/scores.ts:59-69` 一致；limit 上限沿用既有 `GetScoresQueryV1` 语义（待确认：上游上限 100）。

### 4.2 POST /api/public/scores（✅ 官方契约已确认，响应码待复核）

| # | 方法/路径 | 请求 | 响应 | 错误 |
|---|-----------|------|------|------|
| P1 | `POST /api/public/scores` | body `CreateScoreRequest`（见下） | **200 + `{id}` 或 204**（upsert on id；待复核，见下） | 400/401/403/**404**/405 |

**CreateScoreRequest**（zod 直接复用仓库既有移植 `PostScoresBody`，见实现要点）：`id?` string；`traceId?`/`sessionId?`/`observationId?`/`datasetRunId?` string；
`name` **必填** string；`value` **必填** number | string（CATEGORICAL 传 string，BOOLEAN/NUMERIC 传 number，CORRECTION/TEXT 传 string（TEXT 限 1..500 字符））；
`comment?`、`metadata?`；`dataType?` enum `NUMERIC|CATEGORICAL|BOOLEAN|CORRECTION|TEXT`（缺省由 value 推断）；`configId?`
（存在时 score 名/类型/范围须与 config 一致；CORRECTION 不可带 configId）；`source?` enum `API|ANNOTATION`（默认 API；ANNOTATION 必须带 configId；**EVAL 不接受**）。
实现要点：body 校验（zod，**复用 `features/scores/interfaces/api/shared.ts:75-117` 的 `PostScoresBody`**，已含 dataType 推断、
TEXT 1..500、BOOLEAN 0/1 refine、ANNOTATION 缺 configId refine，勿另建 schema 以免漂移）→
`validateAndInflateScore({projectId, scoreId: body.id ?? randomUUID(), body})`——configId 存在性与 score 名/类型/范围一致性校验在此完成，
抛 `InvalidRequestError`→400、`LangfuseNotFoundError`（configId 不存在）→404，这是 404 语义的**唯一来源**（`processEventBatchLite` 返回的 errors 只有 schema 校验 400）→
校验通过后构造 score-create 事件走 `processEventBatchLite` 写 telemetry `scores` 表 → 响应见下。
**响应码待复核**：仓库已移植官方契约 `PostScoresResponse = z.object({ id: z.string() })`（shared.ts:119），langfuse SDK `scores.create`
依赖解析 JSON body——T4 实施时以官方 openapi.yml 复核：若为 200/201 + `{id}` 则按 200 + `{id}` 实现（与既有移植一致）并同步修正本表与 §1 验收；
若确为 204 则同步修正 shared.ts 的 `PostScoresResponse` 移植并说明。

### 4.3 Eval Configs（⚠️ 拟契约，官方无稳定端点，待确认）

| # | 方法/路径 | 请求 | 响应 | 错误 |
|---|-----------|------|------|------|
| E1 | `GET /api/public/evals` | query: `page`, `limit` | 200 `{data: EvalConfig[], meta}` | 400/401/403/405 |
| E2 | `POST /api/public/evals` | body `CreateEvalConfigRequest`（见下） | 200 `EvalConfig` | 400/401/403/404/405 |
| E3 | `GET /api/public/evals/configs` | query: `page`, `limit` | 200 `{data: EvalConfig[], meta}` | 同上 |
| E4 | `POST /api/public/evals/configs` | body `CreateEvalConfigRequest` | 200 `EvalConfig` | 同上 |
| E5 | `GET /api/public/evals/configs/{configId}` | — | 200 `EvalConfig` | 400/401/403/**404**/405 |
| E6 | `PATCH /api/public/evals/configs/{configId}` | body `UpdateEvalConfigRequest` | 200 `EvalConfig` | 同上 |
| E7 | `DELETE /api/public/evals/configs/{configId}` | — | 204 | 同上 |
| E8 | `GET /api/public/evals/{configId}` | — | 200 `EvalConfig`（E5 别名） | 同上 |
| E9 | `PATCH /api/public/evals/{configId}` | body `UpdateEvalConfigRequest` | 200 `EvalConfig`（E6 别名） | 同上 |
| E10 | `DELETE /api/public/evals/{configId}` | — | 204（E7 别名） | 同上 |

**CreateEvalConfigRequest**（拟）：`name` 必填；`scoreName` 必填；`targetObject` 必填 enum `trace|observation|dataset_run_item`；
`filter?` JSON 数组（默认 `[]`）；`variableMapping?` object（默认 `{}`）；`sampling?` number 0..1（默认 1）；`delay?` int ms（默认 0）；
`timeScope?` string[]（默认 `["NEW"]`）；`evalTemplateId?` string；`status?` enum `ACTIVE|INACTIVE`（默认 ACTIVE）。
**EvalConfig 响应**（拟）：`id, name, version, scoreName, targetObject, filter, variableMapping, sampling, delay, timeScope, status, evalTemplateId?, createdAt, updatedAt, projectId`。
**命名/版本语义**（拟，依据上游 unstable/evaluators 行为）：同 projectId 下同名创建时 version 递增（新名 = 1）；PATCH 不改 version。
E1/E3、E8-E10 为同 handler 的路径别名（路由注册顺序注意：见 §7 R4）。

### 4.4 Eval Templates（⚠️ 拟契约，官方无公开端点，待确认；依据 eval_templates 表 + 上游 unstable/evaluators 的命名语义）

| # | 方法/路径 | 请求 | 响应 | 错误 |
|---|-----------|------|------|------|
| T1 | `GET /api/public/evals/templates` | query: `page`, `limit` | 200 `{data: EvalTemplate[], meta}` | 400/401/403/405 |
| T2 | `POST /api/public/evals/templates` | body `CreateEvalTemplateRequest`（见下） | 200 `EvalTemplate` | 400/401/403/404/405 |
| T3 | `GET /api/public/evals/templates/{templateId}` | — | 200 `EvalTemplate` | 400/401/403/**404**/405 |
| T4 | `PATCH /api/public/evals/templates/{templateId}` | body 全可选（同 Create 字段） | 200 `EvalTemplate` | 同上 |
| T5 | `DELETE /api/public/evals/templates/{templateId}` | — | 204 | 同上 |

**CreateEvalTemplateRequest**（拟，字段对齐 `eval_templates` 表 schema.ts:641-658）：`name` 必填；`version` 必填 int（或由服务端按 name 递增，见 §7 D3）；
`prompt?`；`type?` enum `LLM_AS_JUDGE|CODE`（默认 LLM_AS_JUDGE）；`partner?`；`model?`；`provider?`；`modelParams?` object；`vars?` string[]；
`outputSchema?` JSON；`sourceCode?`（CODE 必填）；`sourceCodeLanguage?` enum `PYTHON|TYPESCRIPT`。
**EvalTemplate 响应**：`id, name, version, prompt, type, partner?, model?, provider?, modelParams?, vars, outputSchema?, sourceCode?, sourceCodeLanguage?, createdAt, updatedAt, projectId?`。
**隔离规则**：`projectId = null` 的模板为全局模板，所有项目可见可引用；项目模板仅本 projectId 可见（含写入过滤，见 §7 R5）。
DELETE 影响：`job_configurations.eval_template_id` 为 `onDelete: set null`（schema.ts:674），无需额外清理；若走 §7 D1-B 复用 job_configurations 则需显式置空。

## 5. 任务清单（文件级，按依赖排序）

### T1 eval_configs 表迁移
- [ ] `packages/shared/src/db/schema/schema.ts`：新增 `evalConfigs` 表定义（`eval_configs`：id、created_at、updated_at、project_id FK cascade、
  name、version、score_name、target_object、filter(JSON 文本)、variable_mapping(JSON 文本)、sampling real、delay int、time_scope(JSON 文本)、
  status 默认 ACTIVE、eval_template_id FK eval_templates set null；`uniqueIndex(project_id, name, version)`、`index(project_id, id)`）。
  列名/索引风格严格照抄 `jobConfigurations`（schema.ts:664-685）与 `evalTemplates`（641-662）。若 §7 D1 拍板选 B，本任务缩减为仅修 ensureSchema（见下两项）。
- [ ] `packages/shared/drizzle/0001_*.sql` + `packages/shared/drizzle/meta/0001_snapshot.json` + `_journal.json`：运行
  `pnpm --filter @peri-fuse/shared db:generate`（drizzle-kit generate）生成并提交。
- [ ] `packages/shared/src/db/client.ts`：重写 `ensureSchema()`（101-130）支持增量迁移——按 `_journal.json` 逐条应用未执行的迁移，
  并持久化已应用标记（复用 drizzle-orm/better-sqlite3/migrator 的 `migrate()`，或自建 `__drizzle_migrations` 表）。
  **必须含既有库基线识别**：迁移记录为空（无 `__drizzle_migrations` 表）但 `organizations` 表已存在时，将 0000 标记为已应用
  （写入 journal 记录），仅应用 0001 及后续——否则 migrator 判定 0000 未应用并重放裸 `CREATE TABLE`（`0000_free_bucky.sql` 无 `IF NOT EXISTS`），
  抛 "table already exists"。
  验收：对一份"只有 0000 已应用"的既有库，重启后 `eval_configs` 表存在且旧数据完好；对一份"无迁移记录但已含 organizations 表"的旧库
  同样可增量应用（0000 不重放、仅应用 0001 及后续）。
- [ ] `packages/shared/src/db/types.ts`：导出 `EvalConfig` / `EvalConfigCreateInput`（`InferSelectModel`/`InferInsertModel`，参照 104/172 行）。
- [ ] `packages/shared/prisma/schema.prisma` + `schema.sqlite.prisma`：**可选同步**（低优先）——若加 `model EvalConfig`，改 schema.prisma 后跑
  `scripts/generate-sqlite-schema.mjs` 重新生成。DB 真源是 drizzle（client.ts 头注释确认），prisma 文件仅供兼容参考，本阶段可不改，标注 TODO。
- 验证：`pnpm --filter @peri-fuse/shared run typecheck && pnpm run lint`；新增单元断言（见 T7）。

### T2 features/evals stub → 真实类型
- [ ] `packages/shared/src/features/evals/types.ts`：保留 `EvalTargetObjectSchema`（现有枚举）与导出；新增 `EvalConfigSchema`、`EvalTemplateSchema`
  （对齐 §4.3/4.4 响应字段）、`CreateEvalConfigSchema`/`UpdateEvalConfigSchema`、`CreateEvalTemplateSchema`，zod 风格参照
  `packages/shared/src/domain/score-configs.ts:5-96`（dataType 联动用 discriminated union / superRefine）。
- [ ] `packages/shared/src/features/evals/evalConfigBlocking.ts`：删除 "not available in lite mode" stub；改为真实内容——
  保留 `JobConfigExecutionMode` 枚举（sync/async，已有消费者），新增轻量校验函数（如 `validateEvalConfigFields`：filter/variableMapping 结构、
  sampling ∈ [0,1]、targetObject 枚举），不引入上游的 Redis/ClickHouse 阻塞逻辑。
- [ ] `packages/shared/src/features/evals/index.ts`：新增，聚合导出上述类型。
- [ ] `packages/shared/src/index.ts`：新增 `export * from "./features/evals";`（参照 23-37 行既有 features 导出区）。
- 验证：`pnpm --filter @peri-fuse/shared run typecheck && pnpm --filter @peri-fuse/shared run test`。

### T3 score-configs 路由
- [ ] `packages/shared/src/domain/score-configs.ts`（或 features/scoreConfigs/validation.ts）：新增 `CreateScoreConfigSchema`、
  `UpdateScoreConfigSchema`（对齐 §4.1 字段与校验规则；`minValue ≤ maxValue`、BOOLEAN 必传且须精确为 `[True/1, False/0]` 等联动
  复用既有 `BooleanConfigFields`（domain/score-configs.ts:29-47））。
- [ ] 新增 `packages/server/src/shaping/score-configs.ts`：`dbScoreConfigToApi`（categories JSON.parse、Date → ISO、缺省字段补全）+
  `listScoreConfigsForPublicApi`（分页 + 按 projectId 过滤 + count，drizzle 直查 `score_configs`，参照 `shaping/scores.ts` 的组织方式）。
- [ ] 新增 `packages/server/src/routes/score-configs.ts`：S1-S4 四端点；S1 挂 `authMiddleware` + `responseCache(2_000)`（同 scores.ts:16）；
  404 抛 `LangfuseNotFoundError`（app.ts:53 全局映射）；zod 失败 400 `{message, error: issues}`（同 scores.ts:22-23）。
- [ ] `packages/server/src/app.ts`：`import scoreConfigsRoutes` + `app.route("/", scoreConfigsRoutes)`；**并把 `allowMethods` 增加 `"PATCH"`**（44 行）。
- 验证：`pnpm --filter @peri-fuse/server run typecheck && pnpm run lint`；T7 单测。

### T4 POST /api/public/scores 接线
- [ ] `packages/server/src/routes/scores.ts`：新增 `POST /api/public/scores`（P1）。实现：zod 校验**复用既有移植**
  `PostScoresBody`（`features/scores/interfaces/api/shared.ts:75-117`，含 dataType 推断、TEXT 1..500、BOOLEAN 0/1 refine、
  ANNOTATION 缺 configId refine，勿另建 schema）→ 调 `validateAndInflateScore({projectId, scoreId: body.id ?? randomUUID(), body})`
  ——configId 存在性与 score 名/类型/范围一致性校验在此完成，抛 `InvalidRequestError`→400、`LangfuseNotFoundError`（configId 不存在）→404，
  这是 404 语义的唯一来源（`processEventBatchLite` 返回的 errors 只有 schema 校验 400，无 404 来源）→
  校验通过后构造 ingestion score 事件 `{id, type: "score-create", timestamp, body}` 调 `processEventBatchLite`
  （复用 `routes/ingestion.ts:52` 路径，天然落到 telemetry 写库；score upsert 语义见 §7 R3）→ 成功返回（响应码见 §4.2 待复核项）。
  **不直接 drizzle 写 `scores` 表**——`scores` 在 telemetry DB（`processEventBatchLite.ts:162-183`），metadata DB 无此表。
- 验证：T7 单测 + T8 e2e。

### T5 eval configs 路由
- [ ] 新增 `packages/server/src/shaping/evals.ts`：`dbEvalConfigToApi`（JSON 字段解析）+ `listEvalConfigsForPublicApi`（分页/count/projectId 过滤）。
- [ ] 新增 `packages/server/src/routes/evals.ts`：E1-E10 端点（E3/E4 与 E1/E2 同 handler 复用；E8-E10 与 E5-E7 复用）。
  创建/更新/删除全部写 `eval_configs` 表（按 §7 D1 决策；若选 B 则写 `job_configurations`，shaping 层适配）。GET 挂 responseCache(2_000)。
  **注意：本文件内先注册 `/api/public/evals/templates` 通配需回避——templates 由 T6 独立文件注册，且须先于本文件挂载（§7 R4）。**
- [ ] `packages/server/src/app.ts`：注册 `evalTemplatesRoutes`（T6）→ `evalsRoutes` 顺序（templates 在前）。
- 验证：T7 单测 + T8 e2e。

### T6 eval templates 路由
- [ ] 新增 `packages/server/src/shaping/eval-templates.ts`：`dbEvalTemplateToApi` + 分页列表（含 projectId=null 全局模板 ∪ 本项目模板的并集过滤）。
- [ ] 新增 `packages/server/src/routes/eval-templates.ts`：T1-T5 端点；POST 的 version 语义按 §7 D3 决策；DELETE 前无需清关联（FK set null）；
  projectId 写入 = 当前 auth 项目（全局模板仅 seed，无创建入口）。
- [ ] `packages/server/src/app.ts`：注册 `evalTemplatesRoutes`（**必须先于 evalsRoutes**，见 R4）。
- 验证：T7 单测 + T8 e2e。

### T7 单元测试（vitest）
- [ ] 新增 `packages/server/src/__tests__/score-configs.test.ts`：S1-S4 全绿（创建→读取→PATCH 归档→再创建同名新 config；
  跨项目隔离：A 项目创建的 config，B 项目 GET 404；校验失败 400；categories/dataType 联动 400）。
- [ ] 新增 `packages/server/src/__tests__/evals.test.ts`：E1-E10 + T1-T5（同名 version 递增、PATCH 不改 version、DELETE 204 且再 GET 404、
  全局模板可见性、跨项目隔离 404/403）。
- [ ] 新增 `packages/server/src/__tests__/scores-post.test.ts`：P1（成功且 GET /scores 可查、同 id 重发覆盖、configId 不存在 404、
  name 缺失/value 类型错 400、TEXT 超 500 字符 400、source=ANNOTATION 无 configId 400、source=EVAL 400）。
- [ ] `packages/server/src/__tests__/global-setup.ts` / `test-db-paths.ts`：确认测试库走 T1 的新 ensureSchema 路径
  （增量迁移冒烟，含"无迁移记录但已含 organizations"的基线场景）。
- 验证：`pnpm --filter @peri-fuse/server run test`。

### T8 e2e 扩展
- [ ] `packages/server/e2e/langfuse-sdk-e2e.mjs`：新增 section——(a) raw fetch 版 score-configs CRUD（S1-S4）；
  (b) `POST /api/public/scores`（直接 fetch，响应码按 §4.2 待复核项 + 覆盖语义）；(c) raw fetch 版 evals configs + templates CRUD（E/T 端点）。
  SDK 有 `client.api.scoreConfigs.*` 则优先走 SDK（保持"SDK 兼容"验证目标），evals 无 SDK 方法则 raw fetch（上游 discussion #11754 确认无 SDK 封装）。
- 验证：`pnpm --filter @peri-fuse/server run test:e2e`。

## 6. 验证策略（整体）

1. 静态：根目录 `pnpm run typecheck && pnpm run lint`（新代码无 `as any`，除既有模式外）。
2. 单测：`pnpm --filter @peri-fuse/server run test`（T7 三个新文件 + 既有 31 个 gateway 测试不回归）。
3. shared：`pnpm --filter @peri-fuse/shared run typecheck && run test`（T1/T2 动到 shared）。
4. e2e：`pnpm --filter @peri-fuse/server run test:e2e`（T8；run.mjs 自动起一次性 server）。
5. 迁移专项冒烟：对"仅 0000 已应用"的旧库文件启动 server，断言 `eval_configs` 表被创建且旧数据完好；
   另造一份"无迁移记录但已含 organizations 表"的旧库，断言 0000 不重放、仅 0001 及后续被应用（T1 验收，基线场景）。
6. 手动（可选）：curl Basic auth 冒烟 §4 各端点 + `X-Cache` 头验证 GET 缓存生效。

## 7. 风险与决策点

- **D1（决策点，开工前先拍板）eval_configs 表 vs job_configurations 表**：实测 langfuse 上游 main 分支与本仓库均无 `eval_configs` 表，
  上游 EVAL config 实体即 `job_configurations`（jobType=EVAL，字段 scoreName/filter/targetObject/variableMapping/sampling/delay/timeScope/evalTemplateId
  与拟契约完全同构）。选项：A) 按用户要求新增 `eval_configs` 表（T1 全量实施，与上游结构分叉，后续 eval 引擎需双表维护）；B) **推荐**——不建新表，
  eval configs API 直接读写 `job_configurations`（零迁移、与上游数据模型一致，jobType 恒为 EVAL）。若选 B，T1 缩减为仅修 `ensureSchema` 增量迁移能力，
  且须同步调整：§1 验收第 5 条（改为"不建 eval_configs 表，API 直读写 `job_configurations`"）、T5（写 `job_configurations`）、
  T7（evals 测试打 `job_configurations`）。按 A 实施则删除本条"推荐"倾向或标注已定。
- **D2 score-configs 无 DELETE**：上游契约只有 PATCH archive（§4.1）。用户任务"CRUD"中的 DELETE 在 score-configs 上不实现，用 PATCH `isArchived` 替代；如确需物理删除另行决策。
- **D3 eval template version 语义**：POST 时 `version` 由客户端传（拟契约）还是服务端按 name 递增（上游 unstable/evaluators 行为）？计划默认服务端递增（上游一致），T2 的 schema 按此实现，T6 标注 TODO 对齐。
- **R1（必须修）ensureSchema 增量迁移**：client.ts:117-130 的"organizations 存在即跳过"会导致新表永远不落到既有库。T1 一并修复（migrator 或自建迁移表）；
  修复时须处理**既有库基线**（无迁移记录但表已存在 → 将 0000 标记为已应用，仅应用后续迁移，见 T1），否则 migrator 重放裸 `CREATE TABLE`
  抛 "table already exists"。两处缺口任一存在，生产升级即坏。
- **R2 CORS 缺 PATCH**：app.ts:44 `allowMethods` 无 PATCH，浏览器端 SDK 的 PATCH 会预检失败。T3 一并修。
- **R3 score upsert 语义**：telemetry adapter 的 insert 为 `INSERT OR REPLACE` 整行替换（`sqlite-telemetry-adapter.ts:497`）——同 id 重发
  仅带部分字段时，未带字段会被置 NULL（上游 ReplacingMergeTree 为逐字段合并，语义不同）。T4 实现时核验 score 落库走 insert 还是
  `mergeInsert`（逐字段合并，:518）；若需逐字段语义，路由层需先查后 merge 再写。e2e 覆盖"同 id 重发（完整字段）"与"重发仅部分字段"
  两种用例并明确预期（整行替换 vs 逐字段合并）。
- **R4 路由注册顺序**：Hono 默认 SmartRouter（TrieRouter/RegExpRouter）静态段优先，`/api/public/evals/templates` 与
  `/api/public/evals/{configId}` 的匹配**不依赖注册顺序**；按 evalTemplatesRoutes → evalsRoutes 注册无害，
  若未来改用 LinearRouter 需保持此顺序。
- **R5 全局模板隔离**：`eval_templates.projectId` 可空（schema.ts:645）。读取为 `projectId = X OR projectId IS NULL`；写入恒为当前项目；DELETE 只允许本项目模板（全局模板返回 404/403 待定，默认 404）。
- **R6 契约漂移**：§4.3/4.4 为拟契约（官方无稳定端点）。实现时在路由文件头注释标注 "contract pending upstream alignment" 并链接本计划；上游若发布正式契约（如 /api/public/unstable/evaluators 转正），以稳定端点为准做适配层。
- **R7 单文件 500 行**：evals.ts 若同时塞 E1-E10 会接近上限；若超限，拆 `routes/evals.ts`（列表+创建）+ `routes/evals-by-id.ts`（E5-E10）两个文件，注册顺序不变。
