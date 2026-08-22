# 实验 2：Trace 渐进加载实现后复测

## 状态与环境

**DONE_WITH_CONCERNS**。2026-08-22 在 `localhost:23433`（Node v22.20.0、PID 53375）对
5.74 GB `telemetry.db` 复测。固定 project、trace、session、observation 均与计划一致。
Git HEAD 为 `c08975e`，工作树 dirty，服务为开发进程，因此体积结论可信，细粒度耗时仅作现场参考。
实验未修改产品代码；认证仅在 shell 内存中使用，正文写入 `/dev/null`，未输出密钥或正文。

## 方法与原始数据

每组先等待 3 秒使 2 秒缓存过期，再连续请求两次。时间单位为秒；不混合统计 MISS、HIT
与 SKIP。

| 请求 | run | status | bytes | TTFB | total | cache |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| trace shell (`core,scores,metrics`) | 1 | 200 | 678 | 0.080959 | 0.081021 | MISS |
| 同上 | 2 | 200 | 678 | 0.002254 | 0.002305 | HIT |
| v2 summary（100 条） | 1 | 200 | 96,872 | 0.061162 | 0.061246 | MISS |
| 同上 | 2 | 200 | 96,872 | 0.001861 | 0.001919 | HIT |
| 单 observation 全详情 | 1 | 200 | 952,386 | 0.015771 | 0.016121 | MISS |
| 同上 | 2 | 200 | 952,386 | 0.003151 | 0.003390 | HIT |
| session shell（关闭 observations/IO） | 1 | 200 | 4,295 | 0.107836 | 0.107879 | MISS |
| 同上 | 2 | 200 | 4,295 | 0.001765 | 0.001808 | HIT |
| 默认兼容 trace | 1 | 200 | 191,169,335 | 1.635729 | 1.666478 | SKIP |
| 同上 | 2 | 200 | 191,169,335 | 2.060289 | 2.117974 | SKIP |

主代理随后在同一 23433 进程补测一次默认兼容 session：200、565,012,529 bytes、TTFB
5.5372 s、total 5.7107 s、`SKIP`。该单样本只用于同进程体积口径，不参与耗时统计。

## 分析

trace shell 加首个 100 条 summary 共 97,550 bytes，相对默认 191,169,335 bytes 减少
**99.94897%（约 1,960 倍）**。用户再选择该 observation 后，累计 1,049,936 bytes，仍减少
**99.45078%（约 182 倍）**。单详情为 952,386 bytes，低于 1 MiB 阈值 96,190 bytes；其体积
不可外推到其他 observation。session shell 仅 4,295 bytes，相对同进程默认 session 的
565,012,529 bytes 减少 **99.99924%（约 131,551 倍）**。

默认无参数 trace 两次均返回 200、相同 191,169,335 bytes，且与第 1 轮的 191,169,311 bytes
仅差 24 bytes（0.0000126%），支持默认完整响应行为仍被保留；本轮未运行外部 SDK 契约套件，
故不能宣称所有字段已完成逐项兼容验证。

## 大响应日志

默认 trace 两次请求均产生 `large_api_response` warning：bytes 为 191,169,335，durationMs
分别为 1,632 与 2,058.7，projectId 正确，cache 均为 SKIP。独立结构检查确认日志键恰为
`event/method/path/status/bytes/durationMs/projectId/cache`；path 不含 query，敏感词扫描未发现
Authorization、Basic、public/secret key、请求或响应正文。低于阈值的单详情未产生 warning，
符合阈值语义。

## 结论与局限

固定重型 trace 上，实现已把首屏传输从 191 MB 降至约 98 kB，并把完整 IO 限制到用户选中的
单条 observation；session shell 也不再嵌入 observations/IO。数据支持渐进加载方向和大响应日志
安全字段设计。局限是每种 cache 状态仅一个耗时样本、顺序固定、开发服务与 dirty worktree
可能受 SQLite/OS cache、GC、热重载和并行修改影响；尚未用浏览器瀑布证明不会自动遍历后续页，
也未覆盖多 trace、多 session、并发负载或完整 SDK 兼容矩阵。
