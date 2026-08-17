# Issue: `GET /api/public/sessions/:sessionId` 超大响应（>512MB 触发 500）

- **标签建议**: `bug` / `api` / `performance`
- **创建日期**: 2026-08-17
- **严重度**: 中（数据量大的 session 下接口 500 或响应可达数百 MB）

## 问题描述

`GET /api/public/sessions/:sessionId` 会全量返回该 session 下**所有 trace 的全部 observation 完整 IO**（`input` / `output` / `metadata`，见 `packages/server/src/routes/sessions.ts` 中 `liteGetObservationsForTraces(projectId, traceIds, true)`）。当 session 包含长文段数据时，响应体可超过 512MB，触发 500：

```
Unhandled lite-server error Cannot create a string longer than 0x1fffffe8 characters
```

## 复现

1. 构造一个包含大量长文段 observation 的 session（如：多轮对话、每个 observation 带大段 `input`/`output`）
2. 请求 `GET http://localhost:23332/api/public/sessions/{sessionId}`
3. 响应体超过 512MB 时接口 500

实测 session：`01a005a7-ceee-7bc0-bcf5-8e5783244d7c`

## 根因分析（两层）

1. **数据层**：`sessions/:id` 无条件返回全部 observation 的完整 IO，无分页、无截断、无省略开关。IO 是响应体积的主要来源。
2. **缓存层（已临时修复）**：`response-cache.ts` 缓存前 `await res.text()` 解码整个响应体，undici 解码超过 V8 字符串上限（`0x1fffffe8` ≈ 512MB）抛 `RangeError`，catch 中 rethrow 导致请求 500。

### 已完成的临时修复（未提交）

`packages/server/src/response-cache.ts`：
- 响应体读取由 `text()` 改为 `arrayBuffer()`（绕过 512MB 字符串限制）
- 超大响应（> 32MB 缓存上限）直接透传，`X-Cache: SKIP`，不缓存不重建
- 单飞等待者路径同步修复（`clone().text()` → `arrayBuffer()`）
- 新增 3 个单测（`src/__tests__/response-cache.test.ts`）

**修复后接口不再 500，但响应体积问题依然存在**——这是本 issue 要治理的剩余部分。

## 治理方向（待评估）

- [ ] 与 Langfuse 上游行为对齐：确认上游 `GET /api/public/sessions/:id` 是否返回 observation IO，若返回则确认其分页/截断策略（保持 SDK 兼容）
- [ ] IO 惰性加载：session 列表/详情默认省略 IO，详情面板按需请求（新增 `?includeIo=true` 之类的开关或独立详情端点）
- [ ] observation 分页：`sessions/:id` 响应增加分页结构，避免一次性全量组装
- [ ] 响应压缩：网关/服务器层对超大 JSON 响应启用 gzip/br（对重复查询收益明显）
- [ ] 兜底熔断：单响应超过安全阈值（如 100MB）时给出明确错误而非 500

## 验收标准

- [ ] 长文段 session（含实测 `01a005a7-...`）访问 `sessions/:id` 不 500，响应体积在可接受范围
- [ ] Langfuse SDK 对 `sessions/:id` 的既有调用保持兼容（字段不缺失、结构不破坏）
- [ ] 治理后无回归：`pnpm --filter @peri-fuse/server run test` 全量通过
- [ ] 补充覆盖大数据量 session 的测试用例

## 参考

- `packages/server/src/routes/sessions.ts` — `GET /api/public/sessions/:sessionId`（280 行起）
- `packages/server/src/response-cache.ts` — 已含超限透传（SKIP）机制
- `packages/shared/src/server/observationsTable.ts` — observation IO 的 DB 读取（`liteGetObservationsForTraces`）
