# Phase 3: Eval 执行引擎（LLM-as-Judge 评估流水线）

## 目标

在 server 进程内实现完整的 eval 执行流水线：按 `job_configurations`（eval config）的 filter/sampling 自动挑选 trace/observation 候选，渲染 `eval_templates` 的 prompt，复用 gateway 的 provider 通道调用 judge LLM，解析输出并把结果以 score 形式写回，全程由 `job_executions` 状态机驱动。零外部依赖（无 cron/队列/Redis），单进程内自包含。

可验收标准：

1. 配置好 eval config + judge 模型后，trace 进入系统后（≤ 轮询间隔 + delay）自动产生 `job_executions` 记录并最终 `COMPLETED`，且 `scores` 表出现对应 score 行（`GET /api/public/scores` 可见）。
2. 同一条 trace 重复轮询/重复 ingestion 不会产生重复 job（幂等）。
3. judge 调用失败自动重试（指数退避，上限可配），配置错误（模型未配置、score config 缺失）不重试并记录 error。
4. 采样率 `sampling` 生效：每个候选 trace 恰好被判定一次（命中→执行，未命中→SKIPPED）。
5. 进程重启后残留的 `RUNNING` job 自动回到 `QUEUED` 继续执行。
6. `pnpm run typecheck && pnpm run lint && pnpm run test` 全绿；新增单测 + 集成测试覆盖上述场景（judge 调用被 mock）。

## 前置依赖

- Phase 1（API 兼容层）：提供 `eval_templates` / `job_configurations` 的 CRUD API（web 页面见 Phase 4）。本阶段的表结构已存在（`schema.ts:641/664/687`），若 Phase 1 未完成，测试直接插库、生产可手动插库验证，不阻塞引擎开发。
- 已有基础：`validateAndInflateScore.ts`（写回复用）、`filterToPrisma.ts`（filter 复用）、gateway 的 `resolveModel`/`createAdapter`（judge 调用复用）、`daily-stats.ts` 的 `startDailyStatsMaintenance`（调度器模式参考）。

## 现状（与本阶段相关的代码事实）

### 数据表（packages/shared/src/db/schema/schema.ts，drizzle）

- `eval_templates`（schema.ts:641）：`name/version/prompt/type("LLM_AS_JUDGE")/partner/model/provider/modelParams/vars/outputSchema/sourceCode`。`vars` 是 JSON 数组（变量名清单）；`sourceCode` 对应 CODE 类型 eval——lite 不支持，Phase 3 只支持 `LLM_AS_JUDGE`。
- `job_configurations`（schema.ts:664）：`jobType/status("ACTIVE")/evalTemplateId/scoreName/filter/targetObject/variableMapping/sampling/delay/timeScope`。**这就是 eval config 的载体（上游语义即 job_configurations），无需新建 eval_configs 表**；`timeScope` 为 JSON 数组（如 `[{"type":"relative","value":"7d"}]`），`delay` 为秒。类型 `JobConfiguration` 在 `types.ts:123`。
- `job_executions`（schema.ts:687）：`status/startTime/endTime/error/jobInputTraceId/jobInputTraceTimestamp/jobInputObservationId/jobOutputScoreId/executionTraceId`。已有 (project_id, job_configuration_id, job_input_trace_id) 联合**普通**索引（schema.ts:709）。类型 `JobExecution` 在 `types.ts:124`。**没有重试计数字段**。
- telemetry 表（traces/observations/scores）不在 drizzle 迁移里，由 `sqlite-telemetry-adapter.ts` 的 `initializeSchema` 以 `CREATE TABLE IF NOT EXISTS` 创建（traces 在 :128、scores 在 :245，scores 含 `config_id/source/comment/data_type` 列）；主键 `(project_id, id)`，`traces` 有 (project_id, timestamp DESC) 索引。

### 迁移机制（关键缺陷）

- `packages/shared/src/db/client.ts:117 ensureSchema()`：`schemaAlreadyApplied`（:102）只检查 `organizations` 表是否存在——**一旦存在就整体跳过，所有后续迁移都不会执行**；迁移文件由 `readMigrationSql()`（:85）按文件名排序拼接执行（现有 `drizzle/0000_free_bucky.sql` 单文件）。要给 `job_executions` 加列，必须先改造为"逐迁移应用 + 版本记账"。
- gateway 的 `ensureSchema()`（`packages/gateway/src/db.ts`）同样只跑一次，但 gateway 表本次无变更，不需改造。

### 可复用能力

- filter：lite 下**现成先例**是 `shared/src/server/repositories/lite-queries.ts:128 liteBuildFilterWhere()`——手写字符串 SQL + `@params` 绑定 + 每表列白名单 `LITE_FILTER_COLUMNS`（:68-106，防注入、仅白名单列），`shared/src/server/repositories/scores.ts:2656-2657` 的 lite 分支（走 `liteGetScoresTable`）即此路径。**注意**：`shared/src/server/filterToPrisma.ts:44 tableColumnsToSqlFilter()` 生成的是 drizzle `SQL` 对象，列引用带表别名/join 前缀（`tracesTable.ts:94 tracesTableCols` 的 `t.` 前缀、`generation_metrics."promptTokens"` 子查询列），不能直接拼进 telemetry 库裸 `traces` 表 WHERE（会报 "no such column/table"），需适配（裁剪列、去前缀）或改用 `liteBuildFilterWhere`。
- score 校验：`shared/src/server/ingestion/validateAndInflateScore.ts:25` 是 Central choke point（注释 :28-30），完成 config 关联、dataType 推断、categorical label→数值映射（`mapStringValueToNumericValue` :87）、BOOLEAN 转换；score 行写入逻辑在 `processEventBatchLite.ts:164` 的 `eventToRow` score 分支（可抽取复用）。
- judge 通道（gateway 包，server 进程内可直接 import）：
  - `gateway/src/router/model-resolver.ts:28 resolveModel(modelName, projectId)`：按 projectId 过滤（:42-46，天然项目隔离）、过滤 disabled/cooldown/超预算 provider（:52-60）、解密 `provider.apiKeyEncrypted`（:69-75，用 `GATEWAY_ENCRYPTION_KEY`，server 启动时 `gateway-init.ts` 已加载），返回含 `providerType/baseUrl/apiKey/timeout` 的 `ResolvedDeployment`。
  - `gateway/src/provider/registry.ts:20 createAdapter(type, config)` + `base.ts:54 adapter.call(req, providerModel)`：非流式 fetch，自带 `AbortSignal.timeout(120s)`，4xx 抛 `ProviderError`。
  - 凭证来源：`gateway/src/db/schema.ts` 的 `Provider.apiKeyEncrypted`（:52，直接内嵌 key）或 `Credential.values`（:30，加密 JSON，由 admin 路由 `routes/admin/credentials.ts` 维护，`model-resolver` 目前只读前者）。
- 调度器模式：`shared/src/server/stats/daily-stats.ts:526 startDailyStatsMaintenance()`——`setInterval` + `timer.unref()` + 返回 stop 函数，与 `server/src/index.ts:30` 的接线方式一致；gateway 后台服务同理（`gateway/src/services.ts:14`）。
- 进程内 worker 资产：`shared/src/server/worker/in-process-worker.ts`（lite 模式以 InMemoryQueueAdapter 注册队列 processor，无 Redis/独立进程）与 `shared/src/server/queues.ts`（zod 队列事件定义，已含 `EvaluationExecution`/`CreateEvalQueue` 等 eval 资产，:353-378/:464-481）。D1 已选轮询主路径，本阶段不引入队列消费；T5 worker 池可参考其 processor 注册/并发模型，后续增强（事件触发）路径可直接复用 queues.ts 事件 schema。
- 测试基建：`server/src/__tests__/helpers.ts`（apiGet/apiPost/basicAuth，进程内 `app.request()`；**无 ingestion helper**，打 trace 用既有写法 `apiPost("/api/public/ingestion", { batch })`，见 `ingestion-roundtrip.test.ts:27`）、`global-setup.ts`（建 throwaway SQLite + 种子 org/project/key）、`vitest.config.ts`。**注意：现有测试未设置 `GATEWAY_DB_URL`/`GATEWAY_ENCRYPTION_KEY`，一旦测试触达 gateway db 会落到开发者真实库 `.peri-fuse/gateway.db`（且 `gateway/src/env.ts:31-40` 未设 key 时还会自动生成随机 key 并写盘 `~/.peri-fuse/.encryption-key` 文件），必须补齐**。

### 现状缺口

- `features/evals/types.ts` 仅 `EvalTargetObjectSchema`（trace/observation/dataset_run_item）；`evalConfigBlocking.ts` 是 stub（lite 不做 blocking eval，本阶段不动）。
- 无 eval CRUD 路由（Phase 1 范畴）、无引擎、无调度器、无 web 页面。
- server 内嵌 gateway proxy（`app.ts:80`）只是路由级复用；judge 调用走 adapter 层（不经 proxy 中间件），因此**不写 SpendLog、不经过 rate/parallel limiter**——预算约束仍由 `resolveModel` 的 provider 过滤兜底（软约束），记账缺口列为后续增强。

## 总体设计决策

### D1. 调度：进程内 setInterval 轮询 SQLite（主），事件触发不做（后续增强）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 轮询（server 进程内 setInterval + better-sqlite3） | 覆盖存量数据与重启恢复；天然幂等（去重 join）；实现单一路径；零依赖 | 延迟 = 轮询间隔（默认 30s，可配） | **✓ 主方案** |
| B. ingestion 事件触发 | 低延迟 | 不覆盖存量；trace update 事件会重复触发；ingestion 是同步写路径，不能阻塞 LLM 调用；采样判定与轮询路径重复 | 不做 |
| C. A+B 结合 | 低延迟 + 兜底 | 双路径状态耦合，需引入 PENDING 态与脏标记 | 后续增强：事件只更新"脏标记"让轮询提前，不直接建 job |

实现要点：轮询每 tick 对每个 ACTIVE job configuration 执行候选查询（见 D3）。**双库约束**：`traces`/`scores` 在 telemetry 库、`job_executions` 在 metadata 库（见"现状"），候选查询只能在 telemetry 库执行，随后在 metadata 库事务内对候选逐条 check-then-insert 建 job（better-sqlite3 同步单写者，事务原子性即幂等保证；联合索引 schema.ts:709 兜底查询性能），幂等保证只在 metadata 库内成立。现有 `in-process-worker.ts`/`queues.ts` 的 eval 资产可作并发模型参考、后续增强触发路径可复用事件 schema（见"可复用能力"），但本阶段不引入队列消费路径。多进程部署不在 lite 模型内（单进程 server），风险节注明。

### D2. job_executions 状态机

```
                     ┌───────────────────────────────┐
候选 trace ──► PENDING ──► QUEUED ──► RUNNING ──► COMPLETED
   (tick 内         │            │   (worker 认领)   │
   建行,防重)        │            └──── FAILED ◄──────┘(不可重试错误)
                     └──► SKIPPED        ▲
                         (采样未命中)      └── 重试条件
                                          └──► QUEUED (retry_count+1)
```

- `PENDING`：候选已产生、等待调度 tick 入队。纯轮询下 tick 内"建行+入队"可合并，PENDING 是为后续增强（事件触发）路径预留的统一入口（事件建 PENDING，轮询只认领 PENDING+直查候选）。若实现时确认合并更简，允许省略 PENDING 直接 QUEUED（文档记录决策）。
- `QUEUED → RUNNING`：worker 池原子抢占（`UPDATE job_executions SET status='RUNNING' WHERE status='QUEUED' ORDER BY created_at LIMIT n` 事务——SQLite ≥3.33 支持 UPDATE...LIMIT，ORDER BY 保证抢占确定性）。
- `COMPLETED`：score 已写回，`job_output_score_id` 指向 scores 行。
- `FAILED`：`error` 存错误消息；`retryable` 错误（5xx/超时/网络）且 `retry_count < EVAL_MAX_RETRIES`（默认 2）时，由轮询 tick 在 `next_retry_at <= now` 后置回 QUEUED（`retry_count+1`）；配置错误（模型未配置 / score config 缺失 / 4xx）不重试。`retry_count`/`next_retry_at` 需迁移加列（T1.2）。
- `SKIPPED`：采样未命中的终态（lite 扩展状态，SQLite `status` 是自由 text 无需 CHECK 约束），作用是让去重 join 排除"已判定"的 trace，避免每个 tick 重复扫描未命中候选；无 `job_output_score_id`。
- 重启恢复：调度器启动时执行 `UPDATE job_executions SET status='QUEUED' WHERE status='RUNNING'`（幂等）。
- 并发上限：单进程 worker 池，`EVAL_MAX_CONCURRENCY`（默认 4），由池大小天然限制，DB 层不加 RUNNING 计数。

### D3. 触发条件（filter + timeScope + delay + sampling）

- `filter`（JSON FilterState 数组）：复用 `liteBuildFilterWhere(filter, "traces"|"observations")` + `LITE_FILTER_COLUMNS` 白名单（`lite-queries.ts:128/:68-106`）拼入候选查询，仅支持白名单列；`tableColumnsToSqlFilter` 生成的列引用带别名/join 前缀，需裁剪适配（见"可复用能力"与 R3）。
- `timeScope`：仅支持 `relative`（如 `[{"type":"relative","value":"7d"}]`），绝对时间 `absolute` 标记为后续增强；候选窗口 = `[now - timeScope, now - delay]`（`delay` 秒，给 ingestion 留补全 output 的窗口）。
- 去重（**两段式，因双库无法跨库单 SQL**）：候选查询在 telemetry 库执行、**不带** `NOT EXISTS`；返回候选 id 集后，在 metadata 库事务内逐条 check-then-insert（`INSERT INTO job_executions ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM job_executions j WHERE j.project_id=? AND j.job_configuration_id=? AND j.job_input_trace_id=?)` 或先查后插），命中 `(project_id, job_configuration_id, job_input_trace_id)` 索引（schema.ts:709）。
- 采样：候选查询**返回候选集 + 命中标志列**：`SELECT ..., abs(random()) / 9223372036854775808.0 < :sampling AS hit`。引擎对 hit=1 的行走执行路径（建 PENDING job），对 hit=0 的行插 SKIPPED 行（见 D2）——两类行都算"已判定"，由去重 join 排除，避免未命中 trace 每 tick 反复扫描；每个候选 trace 恰好判定一次。此语义与上游事件驱动一致（事件一次性，采样不中即丢弃）。
- 候选查询一次最多产出 `EVAL_BATCH_SIZE`（默认 100）行，防止单 tick 过载；该限额同时覆盖"执行（hit=1）+ SKIPPED（hit=0）"两类产出，超限部分自然延后到下一 tick（不影响"每个候选恰好判定一次"——判定时机由去重 join 保证）。
- targetObject 范围：本轮引擎仅支持 `trace`/`observation`。`EvalTargetObjectSchema` 含 `dataset_run_item`（`features/evals/types.ts:4`），遇到 targetObject=`dataset_run_item` 的 ACTIVE config，tick 内跳过并 warn（不为其构造候选查询），dataset eval 明确列为后续增强。

### D4. template 渲染（纯函数，零依赖）

- `variableMapping`（job_configurations.variable_mapping，JSON）：`{ varName: { column: "input"|"output"|"metadata", path: "$" | "$.a.b" | "$.a[0].c" } }`。column 对应 trace/observation 表的 JSON 列；path 为简化 JSON path（自写 ~40 行解析器：`$` 根、点路径、数组下标，不支持通配符/过滤表达式）。
- 取值：列值 `JSON.parse` 后按 path 提取；解析失败（非 JSON 文本）则整串作为值。
- 渲染：`evalTemplates.prompt` 中的 `{{varName}}` 占位符替换。字符串值直接插入；对象/数组 `JSON.stringify`；变量未在 mapping 中 → 空字符串 + warn（容错，不 fail）。不引入 handlebars/mustache。
- `vars`（template.vars）作为配置校验清单（Phase 1 用），渲染以 mapping 实际内容为准。

### D5. judge 调用：复用 gateway 的 resolveModel + createAdapter（进程内直连）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 1. 复用 `resolveModel`+`createAdapter`+`adapter.call`（server 进程内直连） | 零新代码；凭证解密/熔断/预算过滤/项目隔离全复用；无端口依赖 | 不写 SpendLog、不经 rate/parallel limiter（judge 成本不可见） | **✓ 主方案** |
| 2. 进程内调用 proxy-router handler | 完整链路（spend/限流/审计） | 需伪造 Hono context 与 gateway ApiKey 鉴权，耦合路由内部实现，复杂度高 | 否决 |
| 3. server 自建 judge 通道（直读 Credential 表 + 自写 fetch） | 与 gateway 解耦 | 重复实现凭证解密/超时/重试，两套逻辑漂移 | 否决 |

执行流程（judgeClient）：`resolveModel(template.model, projectId)` → 无 deployment 抛配置错误（不重试，error 提示到 Gateway 后台配置模型）→ 若 `template.provider` 非空，过滤 `providerName` 不匹配的 deployment → `createAdapter(providerType, {baseUrl, apiKey, timeout})` → `adapter.call({ model: providerModel, messages: [{role:"system", content: renderedPrompt}], temperature: modelParams.temperature, extra: modelParams }, providerModel)`（openai.ts:31 的 `transformRequest` 会把 extra 合并进 body）。路由策略：直接取首个 deployment（Phase 3 不做 weighted/lowest-latency 选路，后续增强可接 strategies）。错误分类：`ProviderError` 5xx/超时/网络 → retryable；4xx / RouterError 404 → 配置错误不重试。
记账缺口：judge 调用不写 `SpendLog`、不计 provider `budgetSpend`（预算超限仅由 resolveModel 解析层过滤兜底）。后续增强：手动 `INSERT SpendLog` + 复用 `gateway/src/spend/calculator.ts` 计费。

### D6. judge 输出解析与写回 scores

- 期望输出（LLM_AS_JUDGE）：JSON `{"score": <number>, "reason": "<string>", "label": "<string>"}`。`outputSchema` 的自定义校验 Phase 3 不做（后续增强），但解析器容错：优先 `JSON.parse`；失败则扫描首个平衡 `{...}` 块（围栏代码块/前导文本容忍）再 parse；仍失败 → 重试 1 次（重新调用 judge）→ 仍失败则 job FAILED，error 记录原始输出。
- 写回选择：**复用 `validateAndInflateScore`**（Central choke point，保证与 API/ingestion 完全一致的校验与 config 覆盖），流程：
  1. 按 `scoreName` 查 `score_configs`（projectId 过滤）——不存在 → job FAILED（与上游语义一致：eval 必须先建 score config）。
  2. 构造 body：`{ traceId|observationId, name: scoreName, value: 数值或 label, comment: reason, source: "EVAL", configId }`（`source: "EVAL"` 已确认可透传，见 R2；`dataType` 由 config 覆盖：numeric→value=score；categorical→value=label，`mapStringValueToNumericValue` 完成映射；boolean→score 为 1/0）。
  3. `validateAndInflateScore` → inflated body → `INSERT INTO scores`（复用/抽取 `processEventBatchLite.ts:164` 的 score 行写入为共享函数）。
  4. 写回 job（**两阶段，非原子**）：`scores` 在 telemetry 库、`job_executions` 在 metadata 库，INSERT scores 与 UPDATE job 无法同事务（telemetry adapter 的 insert 自带内部事务）。第 3 步落 score 完成后，在 metadata 库独立事务 `UPDATE job_executions SET status='COMPLETED', job_output_score_id=?, end_time=?`；存在崩溃中间态（score 已写、job 仍 RUNNING，重启恢复后可能重复打分）——接受小概率重复，如需强幂等可在复查阶段过滤 `job_output_score_id IS NOT NULL` 的已写回行。
- 校验失败路径：`validateAndInflateScore` 经 `validateConfigAgainstBody`（`validateAndInflateScore.ts:192`）校验内容合法性——CATEGORICAL 的 label 不在 config.categories、NUMERIC 越出 min/max、dataType/name 不匹配等会抛 `InvalidRequestError`。此类内容校验失败属输出质量问题而非环境故障：job 置 `FAILED`（error 记录校验消息），**不计入 retryable**（与配置错误同待遇），避免对非法输出反复重试。
- `execution_trace_id`（上游记录 eval 执行 trace）：Phase 3 置 NULL，不创建 execution trace（后续增强可选）。

## 任务清单

### T1 迁移机制改造与 schema 变更（前置，阻塞 T5）

- [ ] **T1.1** 改造 `packages/shared/src/db/client.ts` 的 `ensureSchema()`：从"全量拼接一次"改为"逐迁移文件按序应用 + 版本记账"（`PRAGMA user_version` 自增，简单可靠；不引入新表），`schemaAlreadyApplied` 逻辑替换为版本比对；对已存在旧库（user_version=0 且表已存在）需先标记已应用 0000 再继续。
  - 涉及文件：`packages/shared/src/db/client.ts`
  - 验证：单元测试覆盖三种库状态（全新库、0000 已应用、0000+0001 已应用），`pnpm --filter @peri-fuse/shared run test`。
- [ ] **T1.2** 新增迁移 `packages/shared/drizzle/0001_eval_engine.sql`：`ALTER TABLE job_executions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE job_executions ADD COLUMN next_retry_at INTEGER;`
  - 涉及文件：`packages/shared/drizzle/0001_eval_engine.sql`（手写，与 drizzle-kit 命名约定一致）
  - 验证：对 0000 已应用库执行后 `PRAGMA table_info(job_executions)` 含两列；重复执行幂等。
- [ ] **T1.3** 同步更新 `packages/shared/src/db/schema/schema.ts` 的 `jobExecutions`（:687）定义（`retryCount` integer 默认 0、`nextRetryAt` timestamp_ms 可空）；`types.ts:124` 的 `JobExecution` 类型自动跟随。
  - 涉及文件：`packages/shared/src/db/schema/schema.ts`
  - 验证：`pnpm run typecheck`。

### T2 纯函数（shared，无 IO，先行可并行开发）

- [ ] **T2.1** 扩展 `packages/shared/src/features/evals/types.ts`：`JobExecutionStatus`（PENDING/QUEUED/RUNNING/COMPLETED/FAILED/SKIPPED）、`VariableMapping`/`TimeScopeEntry` 的 zod schema、`JudgeOutput {score?, label?, reason?}`；保留 `EvalTargetObjectSchema` 导出。
  - 涉及文件：`packages/shared/src/features/evals/types.ts`
  - 验证：`pnpm --filter @peri-fuse/shared run test`（类型 + 校验用例）。
- [ ] **T2.2** 新增 `packages/shared/src/features/evals/templateRenderer.ts`：JSON path 提取器（`$`/`$.a.b`/`$.a[0].c`）、变量取值（JSON 列解析 + path）、`{{var}}` 渲染（字符串直插 / 对象 stringify / 缺失空串 + warn）。
  - 涉及文件：`packages/shared/src/features/evals/templateRenderer.ts`（纯函数，≤500 行）+ 同名 `.test.ts`
  - 验证：单测覆盖 path 提取、嵌套、数组下标、缺失路径、非 JSON 列值、缺失变量。
- [ ] **T2.3** 新增 `packages/shared/src/features/evals/judgeOutputParser.ts`：容错 JSON 解析（纯净 / ```json 围栏 / 前导文本 / 首个平衡 `{...}` 块），输出 `JudgeOutput`，失败抛带原文的错误。
  - 涉及文件：`packages/shared/src/features/evals/judgeOutputParser.ts`（纯函数）+ 同名 `.test.ts`
  - 验证：单测覆盖上述四类输入与损坏输入。

### T3 候选查询（server）

- [ ] **T3.1** 新增 `packages/server/src/evals/candidateQuery.ts`：输入 (jobConfiguration, projectId)，输出候选行。实现：`liteBuildFilterWhere` + `LITE_FILTER_COLUMNS` 白名单拼 WHERE（targetObject=trace/observation 对应各自白名单）；`timestamp BETWEEN now-timeScope AND now-delay`（SQLite `datetime()` 运算）；返回候选集 + `abs(random())/9223372036854775808.0 < sampling AS hit` 命中标志列（去重与建 SKIPPED 在 metadata 库侧完成，见 D3）；`LIMIT EVAL_BATCH_SIZE`；`is_deleted=0`。返回结构含 trace/observation 的 id、timestamp、input/output/metadata 原文。
  - 涉及文件：`packages/server/src/evals/candidateQuery.ts`
  - 验证：临时 SQLite 种子 traces 的集成单测（filter 匹配、窗口边界、sampling=1 全中、hit 标志正确）。
- [ ] **T3.2**（可选）把 `processEventBatchLite.ts:164` 的 score 行写入分支抽取为 `packages/shared/src/server/ingestion/insertScoreRow.ts` 共享函数，`processEventBatchLite` 与引擎共用。
  - 涉及文件：`packages/shared/src/server/ingestion/insertScoreRow.ts`、`processEventBatchLite.ts`
  - 验证：既有 ingestion 测试全绿（`ingestion-roundtrip.test.ts`）。

### T4 judge 客户端（server，gateway 复用）

- [ ] **T4.0**（前置）打通 gateway 包导出：`packages/gateway/package.json` 的 `exports` 当前仅 `.`/`./admin-router`/`./db`/`./env`/`./proxy-router`/`./services`，而 server 的 tsconfig 为 `moduleResolution: NodeNext`，严格按 exports 解析——`import "@peri/gateway/model-resolver"` 会直接 TS2307。新增子路径导出 `./model-resolver`（resolveModel）、`./provider`（createAdapter/ProviderError/PeriResponse）、`./spend`（calculator.ts），或从 `gateway/src/index.ts` 集中导出。
  - 涉及文件：`packages/gateway/package.json`（+ `gateway/src/index.ts`，若选集中导出）
  - 验证：server 侧 `import "@peri/gateway/..."` 后 `pnpm run typecheck` 通过（无 TS2307）。
- [ ] **T4.1** 新增 `packages/server/src/evals/judgeClient.ts`：`callJudge(projectId, template, renderedPrompt): Promise<PeriResponse>`——`resolveModel(template.model, projectId)` → provider 过滤 → `createAdapter().call()`；错误分类：导出 `EvalJudgeError { retryable: boolean }`（5xx/超时/网络 → true；4xx、无 deployment → false）。
  - 涉及文件：`packages/server/src/evals/judgeClient.ts`（≤500 行）
  - 验证：对 `@peri/gateway` 的 resolveModel 用测试 gateway db 种子 provider/modelDeployment 后实测（见 T7.1）；错误分类单测。

### T5 引擎（server，状态机 + worker 池 + 写回）

- [ ] **T5.1** 新增 `packages/server/src/evals/engine.ts`：`createEvalEngine({ judgeCall?, maxConcurrency? })`（依赖注入，默认 judgeCall=judgeClient.callJudge，测试注入 fake）：
  - `runOnce()`：每 ACTIVE config 一轮候选查询 → PENDING 建行（metadata 库事务内 check-then-insert，幂等）→ PENDING/QUEUED 认领转 RUNNING（限额 `maxConcurrency`，其余留在 QUEUED）→ 渲染（T2.2）→ judge 调用（T4.1，失败按 retryable 处理）→ 解析（T2.3，失败重试 1 次）→ 写回 score（D6 流程，含 score config 查找 + `validateAndInflateScore` + INSERT + 独立事务更新 job）→ 重试扫描（FAILED + `next_retry_at<=now` + `retry_count<max` → QUEUED，`retry_count+1`、`next_retry_at = now + 2^n * 60s`）。
  - `start()`/`stop()`：worker 池生命周期；`recoverStale()`：启动时 RUNNING→QUEUED。
  - 涉及文件：`packages/server/src/evals/engine.ts`（≤500 行，超限拆 `engine/worker.ts`）
  - 验证：注入 fake judgeCall 的集成单测（状态流转、幂等、重试、4xx 不重试、SKIPPED、score 写入）。

### T6 调度器与接线

- [ ] **T6.1** 新增 `packages/server/src/evals/scheduler.ts`：`startEvalScheduler(engine)`——`setInterval(runOnce, EVAL_POLL_INTERVAL_MS 默认 30_000)` + `timer.unref()` + 返回 stop（完全复刻 `daily-stats.ts:526` 模式）；导出 `runEvalOnce()` 供测试/手动触发。
  - 涉及文件：`packages/server/src/evals/scheduler.ts`
- [ ] **T6.2** `packages/server/src/index.ts` 接线：`ensureGatewaySchema()` 之后、`startGatewayServices()`（:27）旁调用 `startEvalScheduler()`（内部先 `recoverStale()`）；shutdown（:55）中停止。
  - 涉及文件：`packages/server/src/index.ts`
  - 验证：`pnpm --filter @peri-fuse/server run test` 不回归；手动启动观察日志。

### T7 测试基建与集成测试

- [ ] **T7.1** 扩展测试基建：`packages/server/src/__tests__/test-db-paths.ts` 新增 `TEST_GATEWAY_DB`/`TEST_GATEWAY_ENCRYPTION_KEY`；`global-setup.ts` 设置 `GATEWAY_DB_URL`/`GATEWAY_ENCRYPTION_KEY` 并调用 gateway 的 `ensureSchema()`；`vitest.config.ts` env 同步；新增种子 helper（测试项目下插 `Provider`（apiKeyEncrypted 用测试 key 加密）+ `ModelDeployment`）。
  - 涉及文件：`test-db-paths.ts`、`global-setup.ts`、`vitest.config.ts`、`helpers.ts`（或新 `seed-gateway.ts`）
  - 验证：既有测试全绿（确认未污染真实 `.peri-fuse/gateway.db`、未生成 `~/.peri-fuse/.encryption-key`）。
- [ ] **T7.2** 新增 `packages/server/src/__tests__/evals-engine.test.ts`（集成，用 `apiPost("/api/public/ingestion", { batch })` 既有写法打 trace——helpers 无 ingestion helper，见"现状·可复用能力"）：
  1. 全链路：ingest trace → 插 score_config/eval_template/job_configuration（或 Phase 1 API）→ `runEvalOnce()`（fake judge 返回合法 JSON）→ 断言 job COMPLETED + `GET /api/public/scores` 可见 + `job_output_score_id` 回填。
  2. 幂等：`runEvalOnce()` 两次，job 数不变。
  3. 采样：`sampling=0` 全部 SKIPPED、`sampling=1` 全部执行。
  4. 重试：fake judge 第一次抛 5xx 第二次成功 → 最终 COMPLETED 且 `retry_count=1`。
  5. 配置错误：不种 ModelDeployment → FAILED 且 error 含指引；不种 score config → FAILED。
  6. 恢复：手动置 RUNNING → 重新创建引擎 → QUEUED。
  7. delay/timeScope 边界：窗口外 trace 不入选。
  - 涉及文件：`packages/server/src/__tests__/evals-engine.test.ts`

## 验证策略（整体）

1. `pnpm --filter @peri-fuse/shared run test`：T2 纯函数单测、T1.1 迁移机制单测、T3.2 回归。
2. `pnpm --filter @peri-fuse/server run test`：T3.1/T5.1 单测 + T7.2 集成（judge 全 mock，不触真实 LLM）。
3. `pnpm run typecheck && pnpm run lint`。
4. 手动 E2E（可选）：真实 gateway 配一个 Ollama/OpenAI 兼容模型 → 建 score config + eval template + job config → 用 langfuse SDK 打一条 trace → 观察 `job_executions` 状态流转与 dashboard 中 score 出现。

## 风险与决策点

- **R1（最大）迁移机制**：`client.ts` 的 ensureSchema 一次性执行，旧库无法获得新列。T1.1 必须先行；降级方案（不改造机制）：`retry_count` 用 `error` 字段内嵌 JSON 计数，放弃 `next_retry_at` 精确退避——不推荐，避免脏数据。
- **R2 `source: "EVAL"` 枚举（已验证关闭）**：`ScoreSourceArray = ["API","EVAL","ANNOTATION"]`（`shared/src/domain/scores.ts:4`），且 ingestion 校验链（`features/scores/interfaces/shared.ts` 的 `PostScoreBodyFoundationSchema`）无 source 字段、`inflateScoreBody` 透传 `body.source ?? "API"`（`validateAndInflateScore.ts:98`）——`source:"EVAL"` 直接可用，无需扩展 zod 枚举。
- **R3 filter 执行适配**：lite 的现成先例是 `liteBuildFilterWhere` + `LITE_FILTER_COLUMNS`（`lite-queries.ts:128/:68-106`，`repositories/scores.ts:2656-2657` 的 lite 分支走 `liteGetScoresTable` 即此路径），并非 `tableColumnsToSqlFilter`——后者生成的列引用带别名/join 前缀，直接用于 telemetry 库裸 `traces` 表会报 "no such column/table"。T3.1 默认复用 `liteBuildFilterWhere`（仅白名单列，不支持列跳过即跳过），首个单测即验证；若需 `tableColumnsToSqlFilter` 支持完整列集，须显式处理列前缀/裁剪（见 D3）。
- **R4 eval_configs 表**：代码事实是 `job_configurations`（schema.ts:664）已承载全部 eval config 字段，本阶段**不新建表**；若要与上游最新独立 `eval_configs` 对齐，属 Phase 1 建模决策（决策点 D1，默认不建表），届时仅 CRUD 层变更，引擎接口（输入 JobConfiguration）不变。
- **R5 judge 记账缺口**：adapter 直连不写 SpendLog/不计费，judge 成本在 spend 统计中不可见（预算仅由 resolveModel 解析层软约束）。列为后续增强：手动 `INSERT SpendLog` + `spend/calculator.ts`（依赖 T4.0 的 gateway exports 打通）。
- **R6 单进程假设**：幂等依赖"单写者 + 事务 check-then-insert"；多 server 进程部署会退化（可升级 (job_configuration_id, job_input_trace_id) 为 unique 索引加固）。lite 定位单进程，接受。
- **R7 SKIPPED 是 lite 扩展状态**：上游状态机无此态；不破坏兼容（status 自由 text），但 web 端展示时需处理（Phase 4）。
- **R8 候选扫描成本**：filter 窗口内未判定 trace 每 tick 重扫（有 (project_id, timestamp) 索引 + SKIPPED 判定去重），默认 30s 间隔 × 小数据量可接受；量大时调大 `EVAL_POLL_INTERVAL_MS` 或 `EVAL_BATCH_SIZE`，无需改架构。
