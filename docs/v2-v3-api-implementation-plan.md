# Langfuse API v2+v3 兼容实现 Plan（修订版 v2）

> 目标：让 langfuse-cli（4.10.0）对 Peri-Fuse Lite 正常工作 —— 全量实现官方 spec 中的 v2/v3 端点 + CLI canonical 的强相关 v1 补充端点，修复 health 版本检测与 API 路径 SPA 回退。
> 依据：langfuse/langfuse@v4.10.0 `web/public/generated/api/openapi.yml`（/tmp/lf-v4.10.0.yml）+ langfuse-cli 源码与 conformance/goldens/4.10.0.json。
> 修订记录：v2 按 review 意见修正（prompts 语义 / metrics 结构 / scores 数据源 / 范围扩展 / cursor 细节）。

## 1. 调研结论（事实，review 复核后）

### 1.1 官方 API 面（v4.10.0 spec，70 路径）

| 版本 | 路径 | 操作数 | 说明 |
|---|---|---|---|
| v1 | 60 | — | 大部分已实现 |
| v2 | 9 | **12** | datasets×2 + {datasetName}、metrics、observations、prompts×2 + {promptName}×2 + {name}/versions/{version}、scores + {scoreId} |
| v3 | 1 | 1 | `GET /api/public/v3/scores` |

合计 **13 个 v2/v3 操作**，全部 `deprecated=false`。

### 1.2 CLI 契约机制（源码确认）

- 默认 `--api-version latest` = 4.10.0（不检测 health）；`auto` 时 `GET /api/public/health` 必须返回 semver `version`（major 匹配 + ≤ 内置版本），否则 `EXIT_NETWORK`
- **CLI canonical 映射（4.10.0 goldens）**：
  - `scores list` → **v3/scores**（v2/scores 已 deprecated，CLI 拒绝）；`scores create` → POST /api/public/scores（v1）；`scores delete` → **DELETE /api/public/scores/{scoreId}（v1，未实现）**
  - `dataset-items create/list/get/delete` → v1 路径（未实现）；`feedback submit`、`traces delete/delete-many` → v1（未实现，列入已知限制）

### 1.3 代码资产与缺口（review 复核）

- prompts 表已有（schema.ts:515，含 promptDependencies/promptProtectedLabels）✓
- **scores 表在 telemetry adapter 动态建表（sqlite-telemetry-adapter.ts:245）**：无 `metadata` 列、无 `session_id` 列 → v3 的 `details`/`subject` 字段组与 v2 的 `trace` 字段组需加列迁移 + join
- filter 解析器（shared factory.ts）：v2/scores 全覆盖；**v2/observations 与 v2/metrics 需扩展 boolean/null 类型 + json_extract**（stringObject 对 metadata key）
- v1 `routes/scores.ts` 无 DELETE；无 dataset-items 路由
- responseCache（TTL 2s，写路径不清缓存——验收脚本注意）、CORS 全局 ✓、authMiddleware + zod + shaping 模式统一 ✓

## 2. 任务划分

依赖：`T0 → (T1∥T2∥T3∥T4∥T5∥T7) → T6 → T8`（T6 不依赖实现结果，可与 T1..T7 并行，但改 app.ts 与并行任务无文件交集，放最后保险）

### T0 前置（0.5~1d）
- `routes/health.ts`：`{ status, version: "4.10.0" }`，常量提取到 shared 导出（`API_COMPAT_VERSION`），语义=API 兼容面声明
- `shared factory.ts` 扩展：filter 支持 `boolean`（=/<>）、`null`（is null/is not null）类型；stringObject 的 metadata key 过滤走 json_extract
- 验收：`curl /api/public/health` 含 semver；filter 单测过

### T1 v2/v3 scores（2~2.5d）
- 文件：`routes/scores-v2.ts`、`routes/scores-v3.ts`（分开，避免超 500 行）、`schemas/scores-v2.ts`、`shaping/scores-v2.ts`
- **scores 表迁移**（sqlite-telemetry-adapter.ts）：加 `metadata`（text JSON）、`session_id` 列；存量迁移逻辑（参考 adapter 既有迁移先例）
- v2/scores：page/limit 分页 + 18 过滤 + fields（`score`/`trace` 两组，默认含 trace）+ filter JSON；**trace 组 = join traces 表**（userId/sessionId/environment/tags）；**用 userId/traceTags 过滤必须含 trace 组否则 400**；未知字段组 400
- v3/scores：**cursor 分页**：`ORDER BY timestamp DESC, id DESC`，keyset `(timestamp,id) < (lastTimestamp,lastId)`，cursor 载荷 `{v:1, lastTimestamp, lastId}` base64url，limit+1 探测 hasMore，末页 meta.cursor=null；limit>100 → 400；17 过滤参数（与 v2 不同的参数集：id/name/source/dataType/environment/configId/queueId/authorUserId/value/valueMin/valueMax/traceId/sessionId/observationId/experimentId/fromTimestamp/toTimestamp）；value 要求单一 dataType、valueMin/Max 要求 NUMERIC、traceId↔sessionId 互斥、observationId 要求 traceId → 400 校验；fields：`details`（metadata）/`subject`（kind + join）/`annotation` 三组
- 验收：curl v2/v3 各过滤组合；cursor 翻页；CLI `scores list`（v3）与 `--api-version 3.225.3 scores list`（v2）皆通

### T2 v2/observations（1.5d）
- 文件：`routes/observations-v2.ts`、`schemas/observations-v2.ts`、`shaping/observations-v2.ts`
- cursor 分页：keyset 键 **start_time**（非 timestamp）；meta `{cursor}`（无 limit）；max limit 1000
- 参数：fields/expandMetadata/limit/cursor/parseIoAsJson/name/userId/sessionId/type/traceId/level/parentObservationId/isRootObservation/environment/fromStartTime/toStartTime/version/filter
- filter 复用扩展后的 factory.ts；expandMetadata（true 时展开 metadata 键）
- 验收：CLI `observations list`；与 v1 数据形状一致

### T3 v2/datasets（1d）
- 文件：`routes/datasets-v2.ts`、`schemas/datasets-v2.ts`
- GET/POST /v2/datasets（page/limit）、GET /v2/datasets/{datasetName}
- POST 请求体含 **inputSchema/expectedOutputSchema**（JSON Schema，datasets 表有列 ✓，核对 v1 POST 是否已写这两个字段，未写则补）
- 验收：CLI `datasets list`、`datasets create`（带 schema）

### T4 v2/prompts（2d，语义按官方源码）
- 文件：`routes/prompts-v2.ts`、`schemas/prompts-v2.ts`、`shaping/prompts-v2.ts`
- **版本选择**：`version → label（默认 "production"）→ 未指定时 label="production"`；**isActive 不参与选择**（响应中的 isActive 是派生字段 = labels 含 "production"）；GET 同时给 version+label → 400 "Cannot specify both"
- **resolve**：依赖解析开关（默认 true），返回 `resolutionGraph`；**不是版本选择**
- POST：服务端分配 version（max+1 或 1）；新版本自动附加 `latest` label；提供 labels 从旧版本移除（全局唯一）；name 存在但 type 不一致 → 400；唯一约束冲突 → 400；请求体 oneOf（chat 分支 prompt 是数组 / text 分支是 string，type 默认 text）；DB `prompt` 列存 `JSON.stringify({prompt})`
- PATCH {name}/versions/{version}：请求体仅 `newLabels`（required，整体替换；`latest` label 保留管理）
- DELETE：无 label/version 时删除该 name 全部版本，**204 无 body**；label 过滤是 labels contains 语义
- 响应：list = `PromptMetaListResponse`（**无 prompt 字段**：name/type/versions/labels/tags/lastUpdatedAt/lastConfig）；get = 完整 Prompt；404 消息格式对齐官方（`Prompt not found: 'x' with label 'production'`）
- 验收：CLI `prompts list/get/create`；resolve 语义、latest label、PATCH newLabels 行为 curl 验证

### T5 v2/metrics（2.5~3d）
- 文件：`routes/metrics-v2.ts`、`schemas/metrics-v2.ts`、`shaping/metrics-v2.ts`
- GET + `query` 参数（JSON 字符串）：**`{view, dimensions:[{field}], metrics:[{measure, aggregation}], filters:[...]}`**（逐字读 spec description，spec 的 schema 是空 object）
- 4 个 view：observations / scores-numeric / scores-boolean / scores-categorical，各含独立 dimensions/measures 全集（observations 视图 ~17 维度 ~13 度量）
- aggregation 含 `histogram`（`[lower, upper, height]` 元组）；`avg` 对 boolean 返回 true-rate
- 高基数维度（id/traceId/userId/sessionId 等）仅可 filter 不可 groupBy，违规 400
- filters：10 种 type 的 operator/type 表（超出 factory.ts，独立实现）
- 复用 dashboard-compute.ts 聚合逻辑
- 验收：4 个 view 各一个冒烟查询 + CLI `metrics`

### T6 SPA/API 404 修复（0.5h）
- `app.ts`：`app.on(["GET","POST","PUT","PATCH","DELETE"], "/api/public/*", 404 JSON)`（复用 LangfuseNotFoundError 的 `{message}` 形状）；SPA fallback 限定非 `/api/` 前缀（中间件判断 pathname）；`app.notFound()` 全局 JSON 404
- 验收：任意方法 × 未注册 /api/public/* 路径 → 404 JSON

### T7 CLI canonical 补充：scores delete + dataset-items（1.5d）
- `routes/scores.ts` 增 `DELETE /api/public/scores/{scoreId}`（项目隔离 + 404）
- 新 `routes/dataset-items.ts` + schemas：`GET/POST /api/public/dataset-items`、`GET /api/public/dataset-items/{id}`、`DELETE /api/public/dataset-items/{id}`（官方 v1 形状；join datasets/dataset_run_items）
- 验收：CLI `scores delete`、`dataset-items create/list/get/delete` 全通

### T8 测试与验收（1d）
- 每个新路由 vitest 单测（`__tests__/` 模式）
- **cursor 专项**：同 timestamp 多行翻页不重不漏、limit 精确整除页、末页 cursor null、非法 cursor → 400、cursor+过滤组合
- 回归：`pnpm run typecheck && lint && test`
- 端口验收清单见 §4；**已知限制**（写入 README 或 CLI 兼容文档）：feedback submit、traces delete/delete-many 未实现（CLI 调用会 404 JSON）

## 3. 关键决策

1. schema 严格按 spec；不确定处对照官方源码（review 已核对语义）
2. 沿用 zod + authMiddleware + shaping + responseCache 模式
3. cursor：见 T1/T2 细节（DESC、keyset 比较方向、base64url `{v:1,...}`、limit+1、末页 null）
4. filter：复用 shared factory.ts（T0 已扩展 boolean/null/json_extract）
5. 项目隔离：所有查询带 projectId scope（红线）
6. 单文件 ≤ 500 行；T1 预拆 scores-v2/scores-v3 两文件
7. prompts 的 `prompt` 列存 `JSON.stringify({prompt})`，shaping 按 type 解析
8. 并行任务文件边界明确（见 §2 文件清单），避免互相踩文件；跨包改动仅 T0（shared）

## 4. 端口验收测试清单（23432）

```bash
# 1. health 版本检测
curl -s localhost:23432/api/public/health          # 含 version:"4.10.0"
# 2. v2/v3 端点（带认证）
curl -u pk:sk localhost:23432/api/public/v2/datasets
curl -u pk:sk localhost:23432/api/public/v2/prompts
curl -u pk:sk localhost:23432/api/public/v2/observations
curl -u pk:sk "localhost:23432/api/public/v2/metrics?query=..."
curl -u pk:sk "localhost:23432/api/public/v3/scores?limit=50&cursor=..."
curl -u pk:sk localhost:23432/api/public/v2/scores     # 3.225.3 契约下验证
# 3. 404 修复
curl -s localhost:23432/api/public/prompts/v1          # 404 JSON（此前 SPA HTML 200）
# 4. langfuse-cli 实测
bunx langfuse-cli api traces list --api-version auto    # 版本检测通过
bunx langfuse-cli api scores list                       # canonical = v3
bunx langfuse-cli api scores delete <id>
bunx langfuse-cli api prompts list / get / create
bunx langfuse-cli api datasets list / create
bunx langfuse-cli api dataset-items list / create / delete
# 5. 回归
curl -u pk:sk localhost:23432/api/public/traces        # v1 不受影响
```

## 5. 执行流程

1. ✅ plan → review（verification agent，approve-with-changes）
2. 修订（本版）
3. **Workflow 实现**：T0 → T1∥T2∥T3∥T4∥T5∥T7 并行 → T6 → T8（ultracode，每任务一个 coder agent）
4. **Code review fix**：全部 diff 定向 review → 修复 → 复检
5. **验收**：§4 清单全绿 → 收尾
