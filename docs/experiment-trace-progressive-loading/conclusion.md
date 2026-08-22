# 实验结论：Trace 渐进加载与大响应日志

## 研究问题

在保持公开 API 默认行为的前提下，避免 Web 首屏下载 trace/session 的全部 observation IO，
并让后端可靠记录大 API 响应。

## 核心发现

1. 固定重型 trace 的默认响应为 191,169,335 bytes；Web 使用的 shell 与首个 100 条轻量
   summary 合计 97,550 bytes，减少 99.94897%。
2. 固定重型 session 的默认响应为 565,012,529 bytes；Web session shell 为 4,295 bytes，
   减少 99.99924%。
3. v2 observation SQL 现在按字段组投影；轻量页不会从 SQLite 读取 input/output/metadata。
4. Observation 树使用 cursor 手动加载后续页；初始不选中详情。点击 trace root 才取 trace IO，
   点击 observation 才取该 observation 的完整 IO/metadata。
5. 默认无参数 trace/session 接口仍返回完整嵌套数据。trace 默认响应新增
   `observationCount`，因此不是逐字节不变；完整 SDK 字段契约尚未跑外部矩阵。
6. 超过默认 1 MiB 阈值的 API 会输出 `large_api_response` warning。191 MB trace 与 565 MB
   session 均被现场捕获；日志不 clone/缓冲正文，也不记录 query、鉴权或正文。

## 置信度评估

| 结论 | 置信度 | 支撑数据 |
| --- | --- | --- |
| 固定重型 trace/session 的首批传输显著下降 | 高 | 第 2 轮 bytes 与同进程默认响应 |
| 渐进请求不会自动遍历全部页/IO | 中 | React Query enabled 状态与手动 Load more；缺浏览器 waterfall |
| 默认 API 行为向后兼容 | 中 | 默认接口 200、完整数据测试；缺外部 SDK 契约矩阵 |
| 大响应日志准确且不额外缓冲 | 高 | 流式实现、单测、191/565 MB 现场 warning |
| 延迟在其他数据与并发环境同幅改善 | 低 | 单机、固定样本、每种 cache 状态样本有限 |

## 验证反馈处理

- 第 1 轮的旧端口、HIT/MISS 混比与 session 缺测问题，已在独立 23433 当前工作树进程修正。
- 第 2 轮 verifier 指出的初始 trace IO eager 请求已修复为“未选择即不请求”。
- 对抗验证指出日志 sink 异常可能中断响应流，已隔离异常并增加回归测试。
- 默认接口逐字段 SDK 契约、浏览器 waterfall、多数据分布与并发负载未在本轮补齐，保留为局限。

## 后续建议

1. 增加 Playwright 登录 fixture 与网络断言，锁定首屏请求集合及“Load more 前不取下一页”。
2. 增加 Langfuse SDK 契约快照，特别验证新增可选字段和 session 查询参数的默认行为。
3. 在更多 trace/session 分位样本上采集 bytes/TTFB，并观察 `large_api_response` 日志分布后再调阈值。
