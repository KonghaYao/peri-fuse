# 验证报告 2：后台管理员面板可用性——运营治理与数据可信度

## 总体评估

**PARTIAL**

报告对若干静态契约的判断是可信的：Users/Sessions 确实没有时间参数；两条列表 SQL 的 environment 过滤只进入 `traces` 实体分组，而 `trace_metrics` 聚合未进入同一过滤域；两个路由也确实在查询异常时返回 HTTP 200 空数据。线性下钻、删除确认、空态和响应体大小的浏览器结果则只能视为主任务采集摘要，不能视为本报告执行者独立复现。

本轮没有通过完整假设。Users/Sessions 无法直接给出指定时间窗口的聚合值，且筛选语义与 metrics 聚合可能错域；失败与空数据的接口契约也不满足原成功标准。不过报告把 `Unlinked` score 提升为 P1“产品死路”证据不足：该记录没有任何归属引用，UI 显示 `Unlinked` 是诚实终点，最多证实解释性文案不足。API key 部分同样需要降格：`expiresAt` 有存储和鉴权读取闭环，但 `lastUsedAt` 只有字段，当前鉴权实现没有写入它，不能仅靠管理接口返回/前端展示就得到可信的“Last used”。

因此，可立即进入修复的是已由契约直接证明的统计错域、异常 200 空态，以及原计划已明确要求的时间窗口能力；Unlinked score 的后续入口、Enter/Search 的实际摩擦、多样本下钻外部效度和 last-used 的采集语义仍需补充设计或实验。

## 逐维度评估

### 数据完整性: PARTIAL

报告覆盖了计划中的 Users、Sessions、Scores、Observations、Settings，并记录了 URL、控件、少量行数、单样本下钻、删除取消以及 13 个响应的 `bytes`/server `durationMs`。它也明确标出了未覆盖的 reload/back/forward、兼容过滤态、受控失败态和多样本归属链，没有把静态契约写成浏览器恢复事实。

但数据仍不足以完整支持高优先级清单：

- 浏览器证据、计量记录、截图、DOM、HAR 均未落盘；表中精确行数、key 数、响应字节及操作顺序无法由本验证报告独立追溯。报告者对源码的独立检查不能补足浏览器原始证据缺失。
- environment 错域有充分的 SQL 证据证明“可能发生”，但没有同一 user/session 跨环境的对照数据，不能声称本地数据集已经出现错误数值，也不能量化影响。
- Users/Sessions 查询异常的 200 契约已静态证实，但未受控触发，因此实际错误日志、缓存行为和最终 UI 只可由代码链推导，尚非端到端观察。
- Sessions、Observation 来源链均只有一个样本；不能覆盖空 observation、孤儿 observation、混合环境 session 或缺失 trace。
- Scores 空态只测了筛选零结果；“兼容接口过滤”和真实项目无数据仍未分别构造。
- API key 没有创建、激活、过期或真实使用实验；5 条 `web-ui` key 只能与源码策略相容，不能单凭浏览器结果验证自动创建/清理过程。
- 所列 13 个请求均小于 1 MiB，只能证明这些具体响应体；没有完整请求清单，不能证明页面首屏所有请求均已覆盖，也不能证明“首屏不传完整 IO”。

### 方法正确性: PARTIAL

以真实项目、只读下钻和删除 Cancel 检查治理路径，方法与研究问题基本匹配。报告正确采用了上一轮建议的动作定义，明确区分短线性下钻与完整任务，并把 `durationMs` 定义为中间件进入到响应流 `flush`，没有再称为 TTFB。

主要方法偏差仍在：浏览器由主任务采集，报告者只收到摘要，无法判断是否遗漏请求、失败状态或不利样本，也无法验证 DOM 行计数口径。这种“采集与静态整理分离”可以产生方向性发现，但不构成独立浏览器实验。尤其精确 bytes/duration 没有原始日志，verifier 只能验证指标定义，不能验证数值本身。

静态核对结果如下：

- `packages/server/src/routes/users.ts` 中 environment 仅形成 `t.environment LIKE @environment`（106–110 行）并作用于 `page_users`；metrics 子查询只按 `project_id + user_id`（135–148 行）。因此同一 user 跨环境时，`countTraces/firstSeen/lastSeen` 与 observations/tokens/cost 的过滤域确实可能不同。
- `packages/server/src/routes/sessions.ts` 同样只在 `page_sessions` 过滤 `t.environment`（159–180 行），metrics 与 user 聚合只按 `project_id + session_id`（191–215 行）。同一 session 跨环境时，列表 metrics 会混入其他环境；详情查询又只按 projectId/sessionId（302–313 行），不会保留列表环境范围。这是可由 SQL 构造必现的契约缺陷，不是未经证明的泛化；但“当前样本已经受影响”仍未证明。
- Users catch 明确在 190–198 行返回 200 空数组；Sessions catch 在 259–267 行做同样处理。前端只在非 2xx 时生成错误，因而普通空态推断成立。
- `large-response-logger.ts` 计数的是流经 response body 的 chunk bytes（51–66 行），不包括 headers，也不等同于压缩后的网络 transfer size；`durationMs` 包含处理至流消费完成的区间。报告使用“响应 bytes”和“server durationMs”基本恰当，但应进一步注明 body bytes。
- `lastUsedAt`/`expiresAt` 均存在于 schema；然而当前 `auth.ts` 只读取并拒绝过期 key（125–127 行），没有更新 `lastUsedAt`。全仓静态搜索也未找到 last-used 写入路径。因此“数据库和鉴权支持 `lastUsedAt`、`expiresAt`”不准确：前者只有存储字段，后者才有鉴权语义。

### 结论合理性: PARTIAL

以下结论有充分证据：

1. Users/Sessions 的 UI 和 API 都没有时间范围，不能在这两个聚合页直接回答原计划规定的“指定时间内使用量”。Users 的 `lifetime usage` 描述使当前范围更诚实，降低了“暗中误导”的严重度，但不恢复指定时间任务能力；所以按实验预设标准判任务失败仍合理。Sessions 连 lifetime 口径提示也没有。
2. environment 聚合错域是静态可证明的 P1 数据口径风险。正确范围应通过筛选后的 trace id 或与 filtered traces 的 join 约束 metrics，而不能只按 userId/sessionId 汇总。由于没有跨环境对象实测，结论必须保持“契约可导致混用”，不能写成“现有数据已经混用”。原报告基本保留了这个范围限定。
3. DB 异常被 catch 后 200 空数组是静态事实，且前端必然按正常空态处理。这直接违反“请求失败与无数据可区分”，P1 合理。
4. Scores 过滤空态文案缺少筛选语境是事实，Clear 的存在显著降低严重度，P2 合理。
5. 所列响应体均未超过 1 MiB，以及最大列出项为 74,969 B，只能限定于列出的单次样本。报告没有用 server duration 推导稳定延迟，范围控制正确。

以下结论需要修正或降级：

- `Unlinked` score 没有 trace/session/observation 引用时，本来就没有可下钻的归属对象。显示 `Unlinked` 是诚实终点而非产品 bug；原始成功标准要求“未关联数据解释”，所以可把缺少解释评为 P2 信息缺口，但 P1“来源核对死路”把数据缺失归因于 UI，严重度过高。页面已经展示 name、value、source、timestamp、comment；是否需要 score ID、原始 ingestion event 或其他调查入口，应先确认这些信息真实存在且对管理员有用。
- API key 生命周期 P1 混合了三件事。expiry 有字段和鉴权执行基础，可直接返回/展示；`web-ui` 自动创建与最多保留 5 个是源码事实，可补充说明；last-used 则没有更新链路，展示现字段很可能只得到历史 `null`，必须先设计低开销、准确且不过度写库的使用时间记录方案并测试。不能把三项作为一个同等证据强度的 UI 修复。
- Users/Sessions 无显式 Search 只证明交互不一致；Enter 已在样本中成功，未测首次发现时间、误操作率或对照方案，因此只能作为后续可用性假设，不能据此确定修复优先级。
- 单个 session/observation 样本只证明该样本下钻成立。报告已作范围限定，不能在最终结论中推广为所有关联形态。

### 报告质量: PARTIAL

结构完整、事实/推断分栏清楚，尤其正确吸收了上一轮对动作口径、`durationMs` 命名、单样本外推和静态能力/浏览器事实区分的要求。响应结论也使用了“所列请求”限定。

扣分点是原始证据仍不可追溯；`lastUsedAt` 的“鉴权支持”表述不准确；五项 P1 混合了已证实缺陷、预设功能缺失、诚实的数据终态和仍缺写入契约的候选能力。最终状态继续使用 `DONE_WITH_CONCERNS`，没有直接对照 verifier 的 PASS/PARTIAL/FAIL，也没有逐项标出成功标准是否通过，降低了跨轮可比性。

## 关键问题

1. **浏览器证据不是独立且不可追溯**：主任务采集、报告者静态整理，缺少脱敏原始附件，精确结果只能按二手摘要接受。
2. **完整假设未通过**：Users/Sessions 没有时间窗口；`lifetime usage` 只诚实说明 Users 的现状，不足以完成指定时间任务。
3. **environment P1 真实但范围需限定**：SQL 足以证明跨环境对象会造成列表实体与 metrics 统计域不一致；本轮没有证明当前数据集已有数值偏差。
4. **异常 200 P1 已证实**：Users/Sessions 都把 DB 查询异常转换为成功空数组，前端无法区分失败与零数据。
5. **Unlinked P1 不成立**：无任何引用的 score 不存在可生成的归属链接；问题是解释不足，而非来源链接 bug。
6. **Last used 尚无可信数据生产链**：schema 字段存在，但鉴权不写入；只改管理响应和 Settings 无法产出有意义的信息。
7. **外部效度与状态矩阵仍不足**：单样本下钻、未测恢复矩阵、未测受控失败和兼容过滤态。
8. **性能证据只覆盖单次列出响应体**：server duration 不是 TTFB，body bytes 不是完整网络 transfer，也不能据此证明全部首屏 IO 策略。

## 可立即修复与仅后续研究

### 证据充分，可立即修复

1. **Users/Sessions 查询异常返回 200 空数据**：改为非 2xx 错误契约并让现有 `ErrorState` 生效；增加真实空数据与抛错两类路由测试。需检查 `/api/public/*` 兼容性，但不能继续静默伪装。
2. **Users/Sessions environment 统计错域**：让 metrics 与实体行基于同一批 filtered trace ids/join，覆盖 user/session 跨 production/staging、分页、排序和 projectId 隔离测试。
3. **指定时间窗口能力**：原实验计划已明确要求指定时间核对，缺失已由 UI/API 双重证实。可进入实现，但必须先固定 from/to 的边界、默认值以及按 trace timestamp 还是 observation timestamp 归属的口径；Users 的 lifetime 文案应随窗口同步，Sessions 应补充口径说明。
4. **Scores 筛选空态文案**：有 active filters 时显示“当前筛选无匹配”，无筛选时保留项目级空态；继续保留 Clear。属于低风险 P2。
5. **API key expiry 与 web-ui 策略说明**：`expiresAt` 有存储和鉴权基础，可返回/展示；`web-ui` 自动创建与最多 5 条策略可基于现有实现解释。两者应与 last-used 分开交付。

### 证据不足，只能列为后续研究

1. **Unlinked score 调查入口**：保留诚实的 `Unlinked`；先确认合法无关联 score 的业务语义、可用原始字段和管理员任务，再决定是否展示 score ID、事件来源或帮助文案。当前不应按 P1 修“链接”。
2. **Last used**：先实现并验证鉴权成功后的更新语义、写入频率/节流、并发与历史 null 展示，再谈 Settings 列；现有字段不足以支持直接 UI 修复。
3. **显式 Search 与 Enter**：用首次使用者完成时间/错误率或方案对照确认摩擦，当前仅有一致性推断。
4. **下钻普遍性**：补测无 observation、孤儿 observation、缺失 trace、跨环境 session、trace/session/observation 各类 score 后再外推。
5. **URL 恢复和三类状态**：逐模块保存 reload/back/forward/Clear 的原始记录，并分别构造真实空数据、兼容过滤和受控失败。
6. **性能与首屏 IO**：保存完整请求清单/脱敏 HAR；把 body bytes、网络 transfer size、浏览器 timing 与 server duration 分列，并重复采样。

## 改进建议

1. 下一轮将脱敏动作日志、URL/DOM 快照、server 计量原文和请求清单放入实验目录，每个表格行引用证据编号；浏览器采集者与分析者分离时，至少让 verifier 能审计原始记录。
2. 为跨环境错域增加最小确定性夹具：同一 user 和同一 session 各有 production/staging trace，token 数明显不同；断言筛选后的所有列、详情和跨模块链接范围一致。
3. 为 DB 异常设计注入点或 mock，断言非 2xx、`Request failed` 和恢复操作；不要依赖破坏真实数据库。
4. 时间窗口实现前写明统计归属规则、闭区间/开区间、时区、默认窗口及 lifetime 模式，避免只添加控件却继续产生混合口径。
5. 将 P1 清单按“已证实 correctness bug”“原计划要求的缺失能力”“候选 UX 改进”分组，避免优先级掩盖证据强弱。
6. 对 API key 分别验证 expiry、last-used、自动 web-ui key 与删除保护；last-used 必须从写入链路开始，不能以 schema 字段替代运行契约。

## 上一轮反馈的处理情况

**PARTIAL**

已正确吸收：定义动作计数；不再把短下钻等同完整任务；正确命名 server `durationMs` 并否认 TTFB；对单样本和未覆盖空态作范围限定；静态 URL 能力没有冒充浏览器恢复；回归验证了 Errors environment 与 errorId URL 化的所测样本。

仍未吸收：浏览器原始证据没有落盘；没有跨环境同一对象样本；没有系统化多样本根因/归属链；没有实际 reload/back/forward 矩阵；没有受控失败与兼容过滤态。第 1 轮关于“候选展示方案不应仅凭缺字段升级为高优先级修复”的提醒，也没有完全应用到 Unlinked score 和 last-used P1。
