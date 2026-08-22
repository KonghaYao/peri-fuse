# Trace 渐进加载性能实验计划

## 研究问题

在保留 `/api/public/*` 默认响应兼容性的前提下，能否避免 Web 首屏下载 trace/session
中全部 observation IO，并让后端可靠记录超过阈值的 API 响应？

## 已知基线

- 本地 `telemetry.db`：约 5.3 GB。
- 最大 trace：2,133 条 observations，observation IO 约 188,897,355 bytes。
- 已知问题 session `01a005a7-ceee-7bc0-bcf5-8e5783244d7c` 中，单个 trace 的
  observation IO 约 166,538,516 bytes。
- 当前 Web 的 trace 详情直接请求默认 `GET /api/public/traces/:traceId`，默认包含完整
  observations；session 详情也默认嵌入所有 trace 的完整 observations。

## 成功标准

1. Trace/session Web 首屏不请求完整 observation IO；核心信息可以先渲染。
2. Observation 列表分批加载轻量数据，完整 IO 仅在选中详情时加载。
3. 公开 API 的无参数默认响应保持兼容。
4. 后端对超过 1 MiB 的 API 响应输出结构化 warning，至少包含 method、path、status、
   bytes、durationMs、projectId；不记录鉴权和响应正文。
5. 真实大数据复测显示首个响应显著低于原始完整响应；相关测试、typecheck、lint、Web
   build 通过。

## 变量与指标

| 类型 | 内容 |
| --- | --- |
| 自变量 | 请求字段组、分页大小、是否按需加载 IO |
| 因变量 | 响应 bytes、TTFB/总耗时、首屏可用时间、请求次数 |
| 控制变量 | 同一数据库、projectId、trace/session ID、本地服务端口 |
| 安全边界 | 不输出密钥或 IO 正文；所有数据查询保持 projectId 过滤 |

## 实验轮次

1. **基线与最小复现**：真实请求完整 trace/session，测量响应体和耗时；对比已有字段组选项。
2. **实现后复测**：测量轻量核心、分页轻量 observation、单条 observation 详情，并与基线比较。
3. **对抗验证**：检查是否只是把一次大响应改成自动下载全部小响应、是否破坏 SDK 兼容或
   project isolation，以及大响应日志自身是否引入额外缓冲。

## 预期实现边界

- Server 协议层：扩展可选字段/分页能力，默认保持旧响应；增加通用响应体积观测中间件。
- Web 数据层：封装渐进式 query hooks，避免页面直接拼接请求状态。
- Web 视图层：明确区分核心信息、observation 结构和选中 observation IO 的加载/错误状态。
