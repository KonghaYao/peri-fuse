# 对抗验证：后台管理员面板两轮可用性实验

日期：2026-08-22
审查范围：`00_plan.md`、两轮实验报告与 verifier 报告、`conclusion.md`，以及本轮未提交的 server/web/test diff
最终判断：**PARTIAL**
置信度：**高（0.88）**

## 结论

没有发现 P0、project isolation 泄漏或会推翻全部结论的致命错误。`conclusion.md` 对性能、单样本外推、浏览器证据非独立、last-used 无写入链路、Session 详情范围错位等限制披露得较完整；“关键 P1 已修复”对 SQL 统计错域、Errors 筛选与 URL 恢复、Users 下钻上下文和异常不再返回 200 这几项，基本有实现或回归证据支撑。

但整体仍只能判定 PARTIAL，不能升级为 PASS：Session 的窗口只限定列表指标，点击后进入无窗口的完整详情；查询失败的 500/ErrorState/Retry 没有受控测试；新增 usage 测试只覆盖一个 `fromTimestamp + production` 组合，尚未证明 `toTimestamp` 边界、分页/排序和详情范围；API key 只展示 expiry 时间，没有验证 expired 状态的管理员判断体验。两轮浏览器原始证据仍未落盘，也使精确 DOM、行数和 bytes 无法独立追溯。

## 风险分级

### 中风险 1：Session 列表与详情的统计范围不一致

- 列表先以 project、environment、user 和 from/to 过滤 `filtered_traces`，再从同一 trace 集合生成行与 metrics：`packages/server/src/routes/sessions.ts:178-224`。这部分修复正确。
- UI 点击行只导航到 `/sessions/:id`，没有传递筛选参数：`packages/web/src/features/sessions/sessions-page.tsx:269`。
- 详情 schema 只读取 `includeObservations/includeIo`，详情 SQL 只按 `project_id + session_id` 查询全部 trace：`packages/server/src/routes/sessions.ts:298-320`。
- 因此列表可能显示“过去一天 production 的 1 trace / 30 tokens”，详情却显示该 session 在全部时间和环境内的 traces/metrics。它不会泄漏其他 project，但会造成管理员把窗口内摘要与完整详情视为同一口径。
- `conclusion.md` 已在保留意见和后续 P1 中准确披露，故这不是结论隐瞒；但在该问题解决前，“指定时间/环境核对 session usage 的关键阻断已修”应理解为**列表核对已修**，不是端到端任务完全通过。

### 中风险 2：错误状态契约只有静态链路，没有失败测试

- Users/Sessions catch 现在记录后重新抛出：`packages/server/src/routes/users.ts:196-198`、`packages/server/src/routes/sessions.ts:273-275`。
- app 级 `onError` 会把普通异常映射为 500，因此“DB 异常不再伪装成 200 空数据”的静态结论成立。
- 但 `packages/server/src/__tests__/usage-lists.test.ts` 没有注入查询异常，也没有断言 500 body；浏览器没有触发 `ErrorState` 或 Retry。缓存 singleflight、统一错误 body 和前端恢复行为都尚未端到端证实。
- `conclusion.md` 已把该项限定为“契约已修，受控浏览器故障仍待补”，措辞合理；总体成功标准“管理员能区分请求失败和空数据”仍未通过实证。

### 中风险 3：测试覆盖比结论表述窄

- `usage-lists.test.ts:44-120` 构造了同一 user/session 的 production 30 tokens、staging 300 tokens，以及第二 project production 900 tokens。结果严格为 1 trace / 30 tokens，足以同时证明本夹具下的 environment/time 过滤和 project isolation。
- SQL join 也显式使用 `tm.project_id = ft.project_id AND tm.trace_id = ft.id`：Users `routes/users.ts:146-149`，Sessions `routes/sessions.ts:206-209`；trace_metrics 的主键为 `(project_id, trace_id)`，没有重复放大风险。
- 但测试仅设置 `fromTimestamp`；旧 staging trace 同时被 environment 和时间两个条件排除，无法分别证明两个过滤条件各自有效。没有对 `toTimestamp` 的有效边界、from > to、同环境窗口外 trace、分页、排序、cost/cached tokens、session users/tags 做断言。
- `usage-lists.test.ts:122-125` 只验证无效 ISO 返回 400；schema 没有约束 from <= to。反向窗口会返回正常空数据，语义是否接受尚未写进实验口径。
- 所以“新增跨环境、时间窗口和 project isolation 集成测试”字面成立，但应理解为一个组合回归夹具，而非完整矩阵。

### 中风险 4：Users 下钻只静态保证了参数构造，浏览器只验证部分参数

- Users link 正确携带 `userId`、`environment`、`fromTimestamp`、`toTimestamp`：`packages/web/src/features/users/users-page.tsx:149-157`。
- Traces API 已接受相同参数，因此实现方向正确，且 projectId 来自认证 scope，不来自 URL。
- `conclusion.md` 的浏览器证据只明确说保留了 `environment` 和 `fromTimestamp`，没有声称浏览器同时验证 `toTimestamp`，这点没有夸大。
- 仍缺 reload/back/forward、toTimestamp 和特殊字符 userId 的浏览器矩阵；这更适合列为后续证据缺口，而不是当前 correctness 阻断。

### 中风险 5：API key 生命周期只完成部分信息展示

- key list 按 path project id 查询并返回 `expiresAt`：`packages/server/src/routes/manage.ts:100-116`；鉴权确实在过期时拒绝：`packages/server/src/auth.ts:125-127`。Settings 的 `Expires ... / No expiration` 有真实数据依据。
- `web-ui` key 的自动创建、按 createdAt 倒序只保留 5 把、删除更老 key 是现有服务端事实：`packages/server/src/routes/manage.ts:173-213`；既有 `manage-activate.test.ts` 也验证旧会话在 cap 内继续有效和超 cap 后最旧 key 失效。页面文案“自动创建、最多保留五把、较老自动移除”有依据。
- last-used 没有展示，且结论明确说明鉴权没有可靠更新链路；处理正确。
- 但页面没有显式 `Expired/Active` 状态、剩余时间或时区说明，也没有本轮新增的 list-contract 测试断言 `expiresAt`。所以它帮助管理员看到 expiry，却尚未完整验证“生命周期与轮换判断”。`conclusion.md` 将其标为“信息缺口部分修复”是恰当的。

### 低风险：筛选语义与边界尚未统一成书面契约

- Users/Sessions 的 environment 是 `%value%` substring match，不是 Errors 的 exact match。两者都可能合理，但管理员跨页比较时可能误以为同名筛选口径一致。
- Users/Sessions 的 `toTimestamp` 使用 `<=`；日期控件提交本地日末的 UTC ISO，因此 UI 日筛选能包含整天。公共 traces/scores 其他接口可能使用不同的闭/开区间约定。当前没有发生 SQL 错误，但应在 API 或页面口径中明确。
- 页面描述“selected window”在没有任何日期/环境筛选时实际表示全量窗口，意思可理解但不够显式。

## 通过的对抗检查

1. **Project isolation：通过。** 两条列表均以认证 scope 的 `projectId` 过滤 traces，metrics join 再次绑定 project+trace；第二项目同标识、高 token 夹具未混入。未发现从 query 传入 projectId 或跨项目 cache key 风险。
2. **跨环境/time SQL：核心修复通过。** 行数、first/last、tokens/cost 和 observations 都从同一 `filtered_traces` 集合派生；没有继续只按 user/session id 汇总所有 trace_metrics。
3. **Users 下钻上下文：实现通过、浏览器证据部分。** 四个筛选参数均进入 trace URL；结论只声称实测其中 environment/from。
4. **错误状态不再返回 200：静态通过。** rethrow + app onError 的 500 链路明确；端到端错误态仍未验证。
5. **Unlinked score：结论克制。** 没有伪造不存在的 trace/session/observation link，也没有继续把它列为 P1。
6. **API key 文案依据：基本通过。** expiry 的存储/鉴权与 web-ui cap 都有源码依据；没有虚构 last-used。
7. **性能表述：通过。** 最终结论把 server `durationMs` 与网络 TTFB 区分，并把小于 1 MiB 限定在所列单样本请求。

## 对最终结论的建议措辞

保留当前总体标题 `PARTIAL`。建议把表格中的两处“关键阻断已修”进一步限定为：

- Users：**列表统计口径与下钻参数已修；恢复矩阵待补**。
- Sessions：**列表统计口径已修；完整详情仍是全生命周期口径**。

不要把全量 203 tests 等同于这组功能有 203 个覆盖点；应继续写成“全量测试未回归，新增 1 个组合隔离夹具 + 1 个无效参数测试”。查询失败、toTimestamp 独立边界、Session 详情范围与 key expiry contract 应作为下一轮最小验证集。

## 最终判定依据

- **不是 FAIL**：核心 SQL 已正确绑定 project 与 filtered trace，未发现数据泄漏、跨环境聚合仍然错误或凭据风险文案失实。
- **不是 PASS**：原计划中的失败/空态区分没有端到端证据，Session 窗口任务在详情层仍错位，浏览器原始证据不可追溯，测试矩阵也不足以覆盖最终任务契约。
- **因此为 PARTIAL（高置信度）**：实现显著改善管理员列表核对与调查路径，但“端到端治理任务已经验证完成”仍不成立。

## 审查后处置

主任务接受了上述保留意见，但不改变本报告的 `PARTIAL` 判定：

- Session 详情新增可见的 `Full session · all times and environments` 范围提示，并经浏览器确认；它降低误读风险，但没有把列表窗口传入详情，因此中风险 1 仍是部分缓解。
- usage 组合夹具调整为同环境窗口外 trace、异环境窗口内 trace和异项目同标识 trace，并新增独立 `toTimestamp` 断言；environment、from、to 与 project 不再通过同一个排除条件间接证明。单测定向运行 2/2 通过。分页、排序和时间边界矩阵仍未覆盖。
- `conclusion.md` 已按建议把 Users/Sessions 的“关键阻断已修”分别限定为列表统计/下钻参数，以及列表统计/全生命周期详情提示。
