# 运行时内存边界与修复记录

2026-09-13：修复 [内存风险审计](./memory-risk-audit-2026-09-13.md) 中确认的积压路径和条件性风险。未引入外部基础设施。所有 Gateway 记账、缓存键和资源清理继续按项目隔离。

## 费用记录与故障处理

`SpendFlusher.enqueue()` 现在同步提交一个 SQLite 事务，原子更新 SpendLog、DailySpend 和 API key 花费。单条事件使用固定数量的 SQL 参数，不再将历史事件保留在内存重试队列，也不再构造超大多行 INSERT。`start/stop/flush/flushDaily/flushAll` 保留为兼容接口；两个 `GATEWAY_*FLUSH_INTERVAL_MS` 环境变量不再控制记账。

代理在调用上游前检查数据库是否可写；最终记账失败时返回 503，流式响应已开始则发送 SSE 错误并收尾，不发送成功结束标记。前置检查不能保证数据库稍后仍可写：上游已执行而最终事务失败时，费用记录不会落库，客户端会收到失败。没有后台重试，也不会在内存中积压失败事件；不要把 503 理解为上游一定未执行。

同步事务增加请求结束时的 SQLite 写入延迟。回归测试覆盖 2,500 次连续写入、200 次持久写入失败、事务回滚与恢复、跨项目隔离和旧库索引迁移。测试规模用于验证原有参数超限与积压缺陷，不能替代生产吞吐量测量。

`GATEWAY_LOG_REQUESTS=false` 仅关闭请求明细，仍更新每日汇总和预算花费。`GATEWAY_LOG_MAX_BODY_SIZE` 默认 10,240 字节，限制 messages、response、errorMessage 的存储长度。DailySpend 的唯一索引新增 `projectId`，启动时幂等迁移。

## 请求与数据库边界

| 对象 | 默认边界 | 超限或终止行为 |
| --- | --- | --- |
| 主 server `/api/*` 与内嵌 `/v1/*` | 共 64 个活动请求；上传 16 MiB | 容量满返回 503；正文过大返回 413；上传、流式响应和取消清理占用同一请求槽位 |
| 独立 Gateway `/v1/*` 与 `/admin/*` | 共 64 个活动请求；上传 16 MiB | 同上 |
| OTLP gzip | 解压输出 32 MiB，异步解压 | 413，避免无界解压输出 |
| ingestion batch | 10,000 个事件 | 参数校验失败；正文大小限制先于事件处理 |
| SQLite 读池 | 全池在途/等待合计 128 个、参数估算 16 MiB；默认 30 秒截止时间 | 容量满或不可用返回 503；取消/超时拒绝等待并终止执行线程 |
| 单条 SQLite 查询结果 | 最多 100,000 行、估算 64 MiB | 超限返回 413；worker 与同步回退都采用逐行读取检查 |
| Gateway 上游响应 | JSON 32 MiB、SSE 单行 1 MiB、错误正文 64 KiB | 中止或截断错误诊断；取消未读取的 body |

环境变量：`LITE_MAX_ACTIVE_REQUESTS`、`LITE_MAX_REQUEST_BYTES`、`LITE_MAX_DECOMPRESSED_BYTES`；独立 Gateway 使用 `GATEWAY_MAX_ACTIVE_REQUESTS`、`GATEWAY_MAX_REQUEST_BYTES`。详见根目录 `.env.example`。只接受正的安全整数，无效配置使用默认值；提高上限会增加并发内存需求。

SQLite 读线程一次只接收一个执行任务。线程错误/退出后先标记不可用，拒绝受影响请求；仅在旧线程实际退出后补充线程，避免原生查询阻塞时反复创建新 worker。请求参数和查询选项在入队时复制，防止调用者在计量后修改对象绕过限制。资源错误保留到请求边界，响应缓存也检查该错误，避免旧查询层的空结果兜底被返回或缓存为成功。

这些限制是容器、任务和结果的边界，不是进程 RSS 硬上限。JSON 对象、响应编码、单行 SQLite 值、线程消息传递仍有短时分配；页缓存、V8 和原生分配器也会保留内存。同步回退无法在同步 SQL 执行期间响应异步取消，生产默认读 worker 保留截止与取消能力。

## 缓存、日志与后台任务

| 对象 | 边界与释放方式 |
| --- | --- |
| HTTP 响应缓存 | 1,024 项、正文总量 32 MiB、单项 1 MiB，按实际正文 bytes 计量；主动过期清理 |
| 合并请求 | 最多 128 个 owner、每个 64 个 waiter，waiter 最多等待 30 秒；正常、非 200、异常、取消都结束等待并移除订阅 |
| 响应缓冲 | 小块合并到有界缓冲；超过缓存单项限制后继续消费原响应，不 clone/tee 完整大响应 |
| 鉴权缓存 | 4,096 项、30 秒 TTL，主动清理，缓存键使用 secret 摘要并校验 Basic key pair |
| 路由延迟/失败历史 | 每个容器最多 4,096 项、30 分钟 TTL；延迟最多 10 个样本；删除 provider 清理相关记录 |
| 共享缓存 / LocalCache | 每实例默认 16 MiB 容量计量与主动 TTL 淘汰；LocalCache 使用私有快照，入库/出库对象不可修改缓存持有数据 |
| 内存任务队列 | 每队列最多 1,000 个任务、16 MiB；失败历史最多 100 项、1 MiB；最多 128 个队列，bulk 原子准入 |
| 慢日志 | 每个文件流缓冲 64 KiB，轮转时最多两个流；拥塞时丢弃诊断日志并计数/限频告警；关闭最多等 5 秒 |
| PeriFuse 异步上报 | 最多 8 个并发、5 秒生命周期；复制有界输入/输出/metadata；拥塞丢弃上报并计数/限频告警 |
| 日统计与保留期任务 | 本轮结束后再调度下轮；停止时取消；回填与项目遍历以 200 行游标分页 |

诊断日志与可选上报的丢弃策略不适用于费用记账。内存队列的数据、重试选项和返回给调用者的对象使用独立快照；失败历史和延迟任务也受容量限制。队列关闭清除等待/重试计时器，并等待实际运行的 processor 收尾。

Gateway 把下游断连信号传给上游。完成、异常、超时和主动取消统一清理 reader、timer、listener 和 hook 计数；只清理已成功取得的 hook 资源，且每个请求只完成一次。

## Session API 与前端

- SDK 不传分页参数时，保留包含 observations 和 IO 的默认响应形状；超过 10,000 条 trace 返回 413，提示使用分页。
- 添加可选 `page`、`limit`（默认 1/50，最大 500）。分页返回 `meta`；`countTraces`、`totalCost`、`totalTokens`、`sessionDuration` 是整个 session 的汇总，trace/scores/observations 只包含当前页。
- 分页模式最多返回 100 个 user ID，通过 `usersTruncated` 表明截断。`includeObservations=false`、`includeIo=false` 仍可单独使用。
- 页面每次请求 50 条 trace，按需获取详情；分页写入 URL，切页取消旧查询并清空旧页展开状态，失活缓存 30 秒后回收。时间线展示当前页。
- observation 统计改由 SQLite 聚合，不再将 session 的全部原始统计行物化到 JS。先检查 session 规模，再取 trace 明细。

## 验证与已知基线问题

执行全包 typecheck、完整构建（含 Web 生产构建）、Gateway/Server 全套测试，以及共享缓存、队列、读池、请求上下文和维护任务回归测试。本次变更文件运行 Biome 检查。

最终结果：全包 typecheck 与构建通过；Gateway 19 个测试文件、133 项通过；Server 30 个文件、245 项通过、1 项跳过；Shared 除下述两个既有失败文件之外，22 个文件、187 项通过。71 个变更代码文件的 Biome 检查通过（保留鉴权函数原有的 `void` 类型风格警告）；所有变更文件不超过 500 行，没有新增 `as any`。

根命令 `pnpm run test` 仍会被原有 shared 测试阻断：`traces-ui-table-service.test.ts` 导入不存在的模块；`queues.test.ts` 的 monitor-alert fixture 不符合当前 schema。已在 `git archive 6052a465` 的纯基线副本中重现相同两项失败。基线本身的 `biome check .` 也有 65 个错误；当前整仓检查还包含本机生成/忽略目录。本次不改写这些无关文件，修改范围不新增 lint 错误。

建议部署后按原审计的观测方法比较稳定负载下的 RSS、heapUsed、external、arrayBuffers、活动请求与读池深度。现有程序接口可读取 `spendFlusher.stats()`、`responseCacheStats()`、adapter `getReadPoolStats()`、`slowLogWriter.stats()`、`periFuseLoggerStats()`。本次没有生产堆快照或长期线上压测，不能据此承诺 RSS 在每次请求后下降。
