# 后台管理员面板可用性实验结论

日期：2026-08-22
轮次：2 轮实验、2 轮独立核验
总体结论：**PARTIAL → 关键 P1 已修复并回归，仍有待研究项**

## 结论摘要

面板已经具备从异常概览进入 error fingerprint、具体 error、父 observation 和完整 trace 的可用线性下钻，也能从 Users、Sessions、Observations 回到 trace。关键列表响应在本次单样本测量中均小于 1 MiB；这只证明所测页面没有重新出现多 MB 首屏响应，不外推为稳定性能结论。

两轮实验同时发现，管理员真正需要的不只是“能点进去”，还需要筛选口径一致、状态可信、调查上下文可恢复。实现已修复四类关键问题：Errors 增加 environment 并将选中 error URL 化；Users/Sessions 增加 URL 化时间窗口和显式 Search；usage 聚合与 trace 行统一使用 project、environment、time 范围；DB 查询异常不再伪装成 HTTP 200 空数据。Scores/Observations 的过滤空态也会明确表示“当前筛选无匹配”。

API Key 页面现在展示 expiry（没有到期时间时明确显示 `No expiration`），并解释 `web-ui` key 的自动创建和最多保留五把的既有策略。没有展示 last-used，因为当前仅有存储字段，鉴权路径没有可靠更新链路。

## 两轮结果

| 管理任务 | 实验前判断 | 修复后证据 | 当前判断 |
|---|---|---|---|
| Error 发现与根因下钻 | 线性链可用，但无 environment，详情不可分享 | environment 进入 URL；`errorId` reload 后恢复详情 | 关键阻断已修 |
| 指定时间/环境核对用户 usage | 无日期；metrics 可能跨环境混算 | Users 有 From/To、Search；浏览器组合筛选后 1,825 traces 收窄为 212；下钻保留窗口；集成测试隔离跨环境/项目 tokens | 列表统计与下钻参数已修；恢复矩阵待补 |
| 指定时间/环境核对 session usage | 无日期；metrics 可能跨环境混算 | Sessions 有 From/To、Search；SQL 按过滤 trace 聚合；集成测试覆盖同 session 跨环境 | 列表统计已修；详情明确标注为全生命周期口径 |
| 空数据与查询失败区分 | Users/Sessions DB 异常返回 200 空数组 | catch 记录日志后重新抛出，由统一错误处理返回 500；筛选空态单独表述 | 契约已修，受控浏览器故障仍待补 |
| Score 来源核对 | 所测 score 无引用，只显示 Unlinked | 保持诚实终态，不伪造链接；过滤空态改善 | 非 P1；调查入口待研究 |
| API Key 轮换判断 | 删除确认可靠；缺 expiry/策略说明 | 浏览器确认 expiry 文案与 web-ui 五把保留策略可见 | 信息缺口部分修复 |

## 验证证据

- Server typecheck 通过。
- Server 全量测试通过：23 files，203 tests；新增一个分别隔离 environment、from/to 和 project 的组合回归夹具，以及无效时间参数测试。
- Web production build 通过。
- 浏览器确认 Users/Sessions 显示 From/To、显式 Search、Clear 计数和 URL 参数。
- 浏览器确认 Users 下钻 URL 保留 `environment`、`fromTimestamp`。
- 浏览器确认 Settings 显示 `No expiration` 与 web-ui 自动保留策略。
- 第一轮 Errors 修复已通过 201-test 版本的 server 全量测试与 web build；最终全量验证见提交前记录。

这里的 `durationMs` 是 server 从处理开始到响应流结束的时长，不是网络 TTFB。实验没有采集真实 browser waterfall，因此不做网络延迟比较。

## 保留意见

1. 两轮浏览器证据由主任务的持久浏览器会话采集，实验 subagent 只做静态对照和报告整理；报告已披露这一方法偏差。
2. 尚未通过受控 DB 故障在浏览器中验证 ErrorState/Retry，只验证了后端不再返回 200 空数据的实现契约。
3. `Unlinked` score 的解释和继续调查入口仍需多样本研究；不能把不存在的 trace/session/observation 引用伪造成链接。
4. API key last-used 需要先补可靠写入链路，再考虑展示。
5. Session 列表的时间窗口限定列表指标；进入详情仍查看完整 session。后续应增加清晰的范围提示或可选的窗口传递，避免把局部列表指标与完整详情混为一谈。
6. 当前样本不足以对管理员完成任务耗时、总体数据分布或稳定性能做外推。

## 后续优先级

- P1：补受控查询失败的端到端浏览器测试，确认 500、错误文案和 Retry。
- P1：明确 Session 列表窗口与完整详情的范围差异，决定传递窗口还是显式标注。
- P2：采集多类 linked/unlinked score，设计诚实的来源解释与调查路径。
- P2：设计低写放大的 API key last-used 更新机制后再展示。
- P2：下一轮保存脱敏 browser action/URL/network 证据，避免只依赖报告摘录。
