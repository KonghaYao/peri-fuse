# 长时间运行内存增长风险审计

> 历史诊断记录：下文描述修复前的代码与复现结果，行号对应审计时工作区。后续已按用户要求修复这些风险；当前行为、配置与验证结果见 [运行时内存边界与修复记录](./runtime-memory-limits.md)。

审计日期：2026-09-13。代码基线：`6052a46` + 当前工作区；既有 `packages/cli/package.json` 修改未触碰。检查 server、gateway、shared 的服务入口、长期对象、数据库读池、缓存、流式响应和后台任务。

结论：存在可以确定的无界积压路径，优先检查 **SpendFlusher 批量写失败后的永久重试积压**，其次是 **响应缓存错误分支导致请求悬挂**、**已退出的读 worker 仍被分配查询**。流式请求取消不完整、大数据全量读取、后台任务重叠会放大内存占用。没有线上内存曲线、流量或堆快照，因此以下是代码缺陷与风险排序，不等于已确定此次线上增长的根因。

CPU 低不能排除这些问题：保留在数组/Map 中的对象、等待中的请求、被网络或数据库阻塞的任务都可以占用内存而几乎不执行计算。

**1. 优先级最高：费用日志队列可进入“越积越多、永远写不出去”的状态（已复现）**

位置：[flusher.ts:112](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/spend/flusher.ts:112)、[flusher.ts:141](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/spend/flusher.ts:141)、[flusher.ts:179](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/spend/flusher.ts:179)。

- 每次请求结束往 `spendLogQueue` 和 `dailySpendQueue` 追加数据，没有长度/字节上限。
- 默认每 30 秒将整个费用日志队列一次性拼成一条多行 INSERT，没有按 SQLite 参数数量分批。
- INSERT 失败后执行 `unshift(...batch)`，把原批次全部放回；下次又和新数据拼成更大的 INSERT。
- 当失败原因是 SQL 参数数超限时，等待或重试不能使它恢复。数据库不可写或某条数据持续非法也会导致同样的保留模式。
- `dailySpendQueue` 是另一条队列，正常会单独刷写；不能因为看到日报更新就排除日志队列堆积。

实际导入源码，使用临时 SQLite 数据库验证：本机 SQLite `MAX_VARIABLE_NUMBER=32766`。10 条可成功写入；加入 2,000 条后报 `too many SQL variables`，再分别加入 100 条重试，队列保留数依次为 **2,000 → 2,100 → 2,200**，数据库行数始终为 10。整个复现不需要上游故障。

适用范围：独立 Gateway，以及内嵌 Gateway 的主 server。主 server 的 [index.ts:29](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/index.ts:29) 会启动相同的后台服务；“只启动主服务”不意味着不会走这条路径。

建议：按参数数预算分小批次、成功后移除该批，限制内存队列大小，持续失败的数据采用本地 SQLite 持久化待处理记录或明确的拒绝策略；保持花费记录语义，避免静默丢弃。增加队列长度、最老记录年龄、刷写失败原因指标。

排查信号：`[spend-flusher] Failed to write ...`、`too many SQL variables`、`SQLITE_BUSY`、写入失败计数增长、代理请求继续成功而 SpendLog 停止增长。

补充：当前 `GATEWAY_LOG_REQUESTS` / `GATEWAY_LOG_MAX_BODY_SIZE` 仅在 env 中定义，业务路径没有使用，不能把关闭该配置当作有效止损方案。

**2. 响应缓存合并并发请求时，非 200 响应没有结束等待者（已复现）**

位置：[response-cache.ts:109](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/response-cache.ts:109)、[response-cache.ts:126](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/response-cache.ts:126)、[response-cache.ts:181](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/response-cache.ts:181)。

同一个项目、同一个 URL 的并发 GET 共用一个 Promise。首个请求执行完后，如果响应状态不是 200，会直接 `return`；`finally` 只删除 `inflight` 的 Map 条目，没有调用 `finish(null)`。

因此已有等待者永久停在 `await pending`。删除 Map 条目不会 resolve 已经交给其他请求的 Promise。连接仍然打开时，HTTP 请求资源可能随并发错误请求增长；不能仅凭 unresolved Promise 推断它在所有情况下都无法被 GC。

源码中间件 + 实际 Hono 的隔离验证：

| 首个响应状态 | 同 URL 并发数 | 已结束 | 持续等待 |
| --- | ---: | ---: | ---: |
| 200 | 20 | 20 | 0 |
| 400 | 20 | 1 | 19 |
| 404 | 20 | 1 | 19 |

测试用可控异步处理器保证请求确实重叠；不表示所有顺序 400/404 请求都会触发。项目内存在此类调用点，例如 sessions 参数校验错误和缺失 session 的查询。

建议：所有退出路径统一 settle Promise，避免异常响应提前返回遗漏清理；等待者增加超时和请求取消处理。回归测试需覆盖同 URL 并发 400/404/500、handler 抛错以及客户端取消。

**3. SQLite 读 worker 退出后继续收查询，pending Map 可持续增长（已复现退出场景）**

位置：[sqlite-read-pool.ts:63](/Users/konghayao/code/ai/langfuse-lite/packages/shared/src/server/adapters/sqlite-read-pool.ts:63)、[sqlite-read-pool.ts:81](/Users/konghayao/code/ai/langfuse-lite/packages/shared/src/server/adapters/sqlite-read-pool.ts:81)、[sqlite-read-pool.ts:88](/Users/konghayao/code/ai/langfuse-lite/packages/shared/src/server/adapters/sqlite-read-pool.ts:88)。

- 注册了 `message` / `error`，没有 `exit` 处理，也没有可用状态或退出后重建逻辑。
- `error` 只拒绝当时的查询，随后仍可把新请求提交给已不可用的 worker。
- `pending` 无长度上限、无查询超时、无 AbortSignal。慢查询期间也可能积压不同 URL 的读请求。
- 单条 SQL 的普通执行错误被 worker 内 try/catch 返回，不等于 worker 退出；退出风险需检查 worker 异常日志或生命周期事件。

实际启动一个读 worker，成功执行 `SELECT 1` 后强制结束该线程，再提交 20 次 `SELECT 1`：**0 个结束，pending 保留 20 个**。这是故障注入验证，不是发现本机服务正在发生 worker 崩溃。

建议：`error` / `exit` 原子标记不可用并拒绝全部等待请求；调度层排除退出线程，按策略重建；读请求设置队列容量、超时和取消。真实 HTTP 断连也应停止等待。

**4. Gateway 流式请求取消不完整，断连或异常上游会延长对象和连接存活（部分路径已复现）**

位置：[base.ts:98](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/provider/base.ts:98)、[base.ts:162](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/provider/base.ts:162)、[chat.ts:82](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/routes/proxy/chat.ts:82)、[messages.ts:126](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/routes/proxy/messages.ts:126)。

上游 fetch 只有独立超时，没有关联下游请求的取消信号。SSE 路由没有订阅 `onAbort` 来终止上游迭代器。生成器结束时只 `reader.releaseLock()`，没有 `reader.cancel()`；释放锁不能保证取消仍未结束的 body。

使用真实 OpenAIAdapter、替换 fetch 为可观察的 ReadableStream：遇到 `[DONE]` 或消费者提前退出后，均观察到 **body 已解锁，但 cancel 未调用、signal 未 abort**。这是取消缺口验证，未模拟完整网络连接和生产 RSS。

此外，流式回调没有自己的失败/finally 收尾；上游读取异常可能跳过 `runPostFailure`，使并发计数没有归还。`preCall` 后续限流 hook 拒绝也存在相似计数清理问题。计数本身通常较小，但异常请求的生命周期不完整。

建议：将下游取消传到上游 AbortController；生成器结束时取消未读完的 body；无论成功、异常、超时还是断连，都执行一次资源和计数清理。现有流式默认超时 300 秒会限制部分存活时间，因此不宜直接称为每次请求永久泄漏。SSE 行缓冲 `buffer` 也没有单行尺寸上限。

**5. 长 session 全量读取、大响应多份拷贝，会使峰值随历史数据增长（代码确认）**

位置：[sessions.ts:310](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/routes/sessions.ts:310)、[sessions.ts:334](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/routes/sessions.ts:334)、[response-cache.ts:143](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/response-cache.ts:143)。

session detail 没有 trace 分页：取全部 traces，再取全部 observation 统计行和 scores，默认还包含 observation 详情与 IO。`includeIo=false` / `includeObservations=false` 能减少大字段，但仍会读取统计所需的全部 observation 行。

读 worker 用 `stmt.all()` 一次物化结果，再通过消息把结果传到主线程；随后构建视图、JSON、ArrayBuffer、缓存字符串和 Response，多份表示可能同时存活。响应缓存遇到没有 Content-Length 的响应，会先读完整 body 再判断是否超出 32 MiB；因此“缓存容量 32 MiB”不能限制单次请求峰值。并发等待者的 clone + arrayBuffer 会继续放大峰值。

摄入路径也没有 HTTP 总体字节上限：[ingestion.ts:30](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/routes/ingestion.ts:30) 全量 JSON 解析，[otel.ts:30](/Users/konghayao/code/ai/langfuse-lite/packages/server/src/routes/otel.ts:30) 全量读取并同步 gzip 解压；解压未设置最大输出字节。span 字段的后续限制不能防止前置解压/解析峰值。

建议：Dashboard 使用分页、按需详情和数据库聚合；保持 SDK 兼容入口的行为，并为轻量查询提供明确选项；限制请求压缩前后大小和并发数。这个问题通常更符合“大请求之后 RSS 台阶上升”，不能单凭代码认定为 GC 后持续增长的堆泄漏。

**6. 日统计任务没有防重入，会与慢查询形成积压（条件性风险）**

位置：[daily-stats.ts:526](/Users/konghayao/code/ai/langfuse-lite/packages/shared/src/server/stats/daily-stats.ts:526)。

每 30 秒 `void refreshRecentDays()`，只检查 stopped，没有 running 标记。当一次刷新超过 30 秒时，新一轮仍启动；启动回填也可能与刷新重叠。任务等待 SQLite 读池时，主线程 CPU 可以不高。

建议：上一轮完成后再调度，或 running 时跳过本轮；记录执行时长、在运行轮数、读池等待深度。如果观察到刷新耗时远低于 30 秒，该项优先级可下降。

**7. 其他长期容器与已排除的误判**

| 对象 | 判断 |
| --- | --- |
| Gateway `authCache`，[auth.ts:43](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/middleware/auth.ts:43) | 真正没有容量和过期清理。30 秒 TTL 仅控制复用，历史有效 secretKey 仍占 Map。大量创建/轮换 API key 时持续增长；固定少量 key 的重复请求不会无限增加条目。 |
| Gateway `latencyData`，[router/index.ts:21](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/router/index.ts:21) | 每 provider 最多 10 个样本，但已删除 provider ID 没有清理。按 provider 变更量增长，通常远小于请求/日志积压。 |
| InMemoryQueue `failed`，[in-memory-queue-adapter.ts:195](/Users/konghayao/code/ai/langfuse-lite/packages/shared/src/server/adapters/in-memory-queue-adapter.ts:195) | 失败 job 永久保留，waiting 也无上限。但当前标准 server 摄入直接写 SQLite，未找到入口启动/使用该 adapter 的运行路径。应标为潜在组件缺陷，不应作为正常摄入根因。 |
| 共享内存缓存 / LocalCache | 有条数上限，但无字节上限；惰性 TTL 不等于到期主动释放。当前 Redis 为 null stub，model-match 本地缓存默认关闭，不能仅凭文件存在就判断生效。 |
| 读 worker statement cache | 超过 256 后会 clear；不能作为无界 SQL 缓存泄漏报告。 |
| 出站 Agent policy cache | 每种资源有 32 个策略上限。不是“Map 都没上限”。 |
| 慢日志 writer，[writer.ts:70](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/slow-log/writer.ts:70) | 忽略 write() 背压。开启慢日志且磁盘写入长期赶不上产生速度时可能缓冲增长；默认关闭，优先级较低。 |
| PeriFuse logger，[peri-fuse-logger.ts:132](/Users/konghayao/code/ai/langfuse-lite/packages/gateway/src/hooks/peri-fuse-logger.ts:132) | 配置上报端点才运行；每次请求异步发送完整输入/输出，没有并发上限，也没有显式消费或取消响应 body。超时为 5 秒，慢上报可放大短时占用，不应直接断言无限保留。 |

**8. RSS 上涨也可能来自有界缓存逐渐填充**

[sqlite-telemetry-adapter.ts:118](/Users/konghayao/code/ai/langfuse-lite/packages/shared/src/server/adapters/sqlite-telemetry-adapter.ts:118) 配置主连接 `cache_size=-64000`，约 62.5 MiB；每个读 worker 的 `-8000` 约 7.8 MiB，默认 2–4 个线程。四个 worker 加主连接的页缓存目标合计约 93.75 MiB，还不含线程 V8 堆、原生 statement、查询结果等。这些是缓存目标，不能当作整个进程的内存硬上限。

响应缓存设有 1,024 条、`32 * 1024 * 1024` 计数限制，但实际累计的是 `body.length`（UTF-16 code unit），不是严格内存字节，且不统计 Map/key 等开销。过期仅按访问或容量淘汰，并非到期立即归还内存。填充后不立刻下降本身不足以证明泄漏。

当前 `prisma` 导出已是 Drizzle/better-sqlite3 别名，见 [db.ts:1](/Users/konghayao/code/ai/langfuse-lite/packages/shared/src/db.ts:1)，不应依据旧架构文档优先归因于 Prisma 引擎。

**9. 将风险定位为线上根因所需的最少数据**

建议同一进程每 30–60 秒记录：`rss`、`heapUsed`、`heapTotal`、`external`、`arrayBuffers`，以及请求速率、活动 HTTP/SSE 数、费用队列长度/年龄、各 worker 的 pending 数和存活状态、日统计任务时长。`arrayBuffers` 包含在 external 中，不能再次相加；有 worker 时还需单独采样各线程的堆，主线程 heapUsed 稳定不足以排除 worker 堆增长。若监控的是容器总内存，还应区分进程匿名内存和文件缓存。

| 观察 | 优先验证 |
| --- | --- |
| heapUsed 和费用队列一起增长，SpendLog 停止增加 | 第 1 项 |
| 错误响应后活动请求数持续增加 | 第 2 项 |
| 某 worker 已退出，pending 仍上涨 | 第 3 项 |
| 断连率/流式并发上升，external 或连接数升高 | 第 4 项 |
| 打开长期 session 后出现大响应告警和 RSS 台阶 | 第 5 项 |
| 日统计执行超过 30 秒，多轮同时进行 | 第 6 项 |
| 预热后停止增长，队列/连接稳定 | 优先考虑有界缓存与分配器保留 |

代码中现成的 `responseCacheStats()` 只给出缓存条目与字符计数，无法反映上述完整进程占用；未发现业务入口已有覆盖这些对象的周期内存采样。

**10. 本次验证与修改边界**

使用 Node.js v22.20.0、项目已安装依赖，导入实际源码模块进行隔离验证。命令：

```bash
node --expose-gc /private/tmp/perifuse-memory-audit-20260913/check.cjs
```

[诊断脚本](/private/tmp/perifuse-memory-audit-20260913/check.cjs) / [完整结果](/private/tmp/perifuse-memory-audit-20260913/results.json)。脚本位于本机临时目录，重启或系统清理后可能失效。数据库使用新建临时目录，结束后删除；上游 fetch 为内存 mock；不访问生产数据库或远端服务。它断言的是上述缺陷能复现，退出码 0 表示复现符合预期，不表示业务通过了健康检查。没有做持续压测或测量生产内存曲线。

本次只新增审计报告，没有修改业务代码，因此没有运行全量类型检查、lint 或包测试。建议修复顺序：费用日志分批和容量保护 → 合并请求所有分支 settle → worker 生命周期和队列保护 → 流式取消 → 大查询与定时任务。
