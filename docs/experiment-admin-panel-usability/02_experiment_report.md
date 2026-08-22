# 后台管理员面板可用性实验：第 2 轮

## 基本信息

- 实验主题：运营治理与数据可信度
- 执行日期：2026-08-22（Asia/Shanghai）
- 实验对象：Default Project，`http://localhost:23433`
- 控制条件：现有本地大数据、1280×720 左右桌面暗色视口、不测试 Gateway、不创建或删除业务数据/API key、不复制 secret
- 目标路径：Users ↔ Traces；Sessions → trace → observation；Scores/Observations → 来源；Settings
- 假设：管理员可在指定时间/环境内核对用户和会话使用量，从 score/observation 回到归属对象，并理解 API key 生命周期与风险。
- 最终状态：**DONE_WITH_CONCERNS**

## 方法

1. 由主任务在现有授权浏览器会话中逐页检查 Users、Sessions、Scores、Observations、Settings，并提供 URL、DOM 摘要、行数、动作结果及接口计量原始记录。
2. 对 Users/Sessions 验证筛选控件、Enter 提交、URL 参数和跨模块下钻；对 Scores/Observations 验证日期/环境控件、显式 Search、空态与来源链接。
3. 对 Settings 只打开一个既有 key 的删除确认并点击 Cancel；未点击 Create、Copy 或最终 Delete。
4. 由本报告执行者独立检查前端状态管理、页面渲染和 server 查询契约，并与主任务浏览器证据交叉对照；没有修改产品代码。
5. 响应性能仅报告 `bytes` 与 server `durationMs`。`durationMs` 是服务端中间件进入至响应流 `flush` 的耗时，不是浏览器或网络 TTFB。

### 动作计数协议

- 一次点击、一次筛选值提交（包括 Enter）、一次展开均各计 1 个动作。
- “线性下钻动作”只描述从列表进入详情/来源的点击链。
- “完整任务”还必须包含指定时间、指定环境、核对口径与来源解释；本报告不把短下钻路径等同于完整任务成功。

### 证据来源与方法偏差

| 证据类型 | 来源 | 用途与限制 |
| --- | --- | --- |
| 浏览器 DOM、URL、行数、动作结果 | 主任务于 2026-08-22 提供的应用内浏览器原始采集摘要 | 本报告执行者没有独立复现整轮浏览器操作；只能审阅主任务提供的记录，无法排除未记录请求或选择性遗漏 |
| 响应 `bytes`、server `durationMs` | 主任务提供的本地 server 计量记录 | 单次样本；只描述列出的请求，不外推总体性能，不称 TTFB |
| 静态契约 | 当前工作树源码，重点为 `users-page.tsx`、`sessions-page.tsx`、`scores-page.tsx`、`observations-page.tsx`、`settings-page.tsx`、`routes/users.ts`、`routes/sessions.ts`、`routes/manage.ts`、`large-response-logger.ts` | 可确认参数、查询和文案契约，但不能代替实际浏览器行为 |

本轮浏览器采集与报告分析仍由不同执行者完成，且原始 HAR/截图/DOM 文件未单独落盘。因此本报告是“主任务浏览器证据 + 独立静态对照”的整理，不称为独立浏览器复现。首次工具可用性不作为产品结论。

## 原始数据

### 第 1 轮修复回归

| 检查项 | 浏览器结果 |
| --- | --- |
| Errors 环境筛选 | 已出现 Environment textbox；提交 `default` 后为 `/errors?environment=default` |
| Errors 零结果 | 不存在环境返回 170 B，显示 `No errors match this investigation window.`，Clear 可恢复 |
| error detail URL 化 | 选择后 URL 为 `/errors?range=7d&search=provider_or_stream_failure&errorId=gen_...` |
| reload 恢复 | reload 后 `Error evidence` 与 `Open full trace` 均恢复 |
| 数据环境 | 另观察到 `production`、`staging` observation 环境 |

回归证据支持第 1 轮的两个修复方向在所测样本成立；它不证明所有 error 类型或跨项目恢复均正确。

### Users ↔ Traces

| 检查项 | 浏览器结果 |
| --- | --- |
| 默认页 | `/users`；2 个 textbox（user/environment）；无日期按钮；无显式 Search 按钮；描述为 `lifetime usage`；4 个数据行 |
| user 提交 | 输入 `KonghaYao` 并按 Enter → `/users?userId=KonghaYao`；2 个数据行 |
| 跨模块链接 | 点击用户 → `/traces?userId=KonghaYao`；51 个 DOM 行 |
| 时间能力 | 页面和 API 参数均无 from/to/range；只能核对 lifetime usage |
| 环境能力 | environment 可提交并 URL 化；浏览器证据未提供跨环境同一用户的指标对照 |

静态契约显示用户行的 first/last/countTraces 在 `traces` 查询中受 environment 约束，但 countObservations/tokens 来自仅按 `projectId + userId` 聚合的 `trace_metrics` 子查询，没有 environment 条件。若同一用户跨环境，行级 trace 计数与 usage 指标范围可能不一致；本轮没有混合环境用户样本用于量化影响。

### Sessions → trace → observation

| 检查项 | 浏览器结果 |
| --- | --- |
| 默认页 | `/sessions`；2 个 textbox；无日期按钮；无显式 Search 按钮；51 个 DOM 行；分页 `1–50 of 870` |
| environment 提交 | 输入 `default` 并按 Enter → `/sessions?environment=default` |
| 详情下钻 | 打开 session `01a0100d...` → session heading 与 `Observation tree` |
| 渐进加载 | 展开 1 个 trace 后出现 `agent-run`、`step`、`Read ERROR` 节点 |
| 时间能力 | 页面和 API 参数均无 from/to/range |

对这个 session 样本，列表 → session → trace 展开 → observation 节点的线性路径成立。该结果只覆盖一个 session 的一个 trace，不外推无 observation、孤儿 observation 或跨环境 session。

静态契约显示 session 行及 countTraces 受 environment 约束，但 token/cost 聚合仅按 `projectId + sessionId` 查询 `trace_metrics`，没有 environment 条件。若一个 session 横跨多个环境，筛选后的 usage 可能仍包含其他环境；详情 URL 也不保留列表 environment 参数，并按 sessionId 返回该 session 的全部 trace。本轮没有跨环境 session 样本用于量化。

### Scores / Observations → 来源

| 模块 | 控件与行 | 来源/空态浏览器结果 |
| --- | --- | --- |
| Scores | `/scores`；From/To date、environment、显式 Search；DOM 2 行（含 header） | `acc-session-score = 42` 显示 `Unlinked`，无 session/trace 链接；记录确实没有 trace/session/observation 引用。不存在环境 → `/scores?environment=nonexistent-admin-test`，仅显示 `No scores found.`，有 `Clear (1)` |
| Observations | `/observations`；From/To date、environment、显式 Search；DOM 26 行 | 每行提供 trace 链接；点击首条 → `/traces/01a0101072017ff0862bad268bf675e7`，显示 heading 与 `Observation tree` |

`Unlinked` 对该 score 是诚实的数据状态，不应凭空生成来源链接；但页面没有解释为何未关联、是否仍属当前 project、可用哪些 ID/元数据继续核对。Observation 来源链只验证了一行，不外推所有 observation。

### Settings：API key 生命周期与危险操作

| 检查项 | 浏览器结果 |
| --- | --- |
| key 列表 | 10 个 public key；其中 5 条 note 为 `web-ui`；`Create new key` 1 个；`Delete key` 10 个 |
| 生命周期信息 | `Last used` 可见文本 0；页面显示 public key、masked secret、创建日期和 note |
| 删除确认 | 首个 key 的 dialog 显示 `Delete API key?`、`stop working immediately`、`cannot be undone` 和具体 public key |
| 取消 | 点击 Cancel 后 dialog 数为 0，key 仍为 10 个 |
| 安全约束 | 未创建、删除或复制 key/secret |

静态契约显示数据库和鉴权支持 `lastUsedAt`、`expiresAt`，但管理列表响应和前端 `ProjectKey` 类型均未返回/展示这两个字段。项目激活接口会创建 note 为 `web-ui` 的 key，并只保留最近 5 个 web-ui key；Settings 没有说明这一自动生命周期。这能解释所见 5 条 `web-ui` note，但浏览器证据本身没有触发或验证自动创建/清理过程。

### URL、Search、清空与状态恢复矩阵

| 模块 | 时间控件 | 环境控件 | 文本提交 | URL 化 | Clear | 恢复证据 |
| --- | --- | --- | --- | --- | --- | --- |
| Users | 无 | 有 | Enter；无显式 Search | `userId` 已验证 | 有筛选时出现 | 未提供 reload/back 原始记录 |
| Sessions | 无 | 有 | Enter；无显式 Search | `environment` 已验证 | 有筛选时出现 | 未提供 reload/back 原始记录 |
| Scores | From/To | 有 | 显式 Search | `environment` 已验证 | `Clear (1)` 已验证存在 | 未提供 reload/back 原始记录 |
| Observations | From/To | 有 | 显式 Search | 源码支持 URL 状态；本轮未给出提交后原始 URL | 源码支持 | 未提供 reload/back 原始记录 |

`useTableState` 会把声明的筛选写入 query string、删除空值并将页码重置为 1，属于静态契约。由于本轮没有逐模块执行 reload/back/forward，不能把契约能力写成已验证的浏览器恢复事实。

### 空态与失败态

- 浏览器验证 Scores 的过滤零结果只显示 `No scores found.`；文案没有说明是“当前筛选无结果”，但有 Clear。
- 未以受控方式触发浏览器请求失败；不能评价实际失败时的视觉恢复操作。
- 静态前端有独立 `ErrorState`，正常 HTTP/network error 会显示 `Request failed`；401 会指向 Settings。
- 但是 Users 与 Sessions server 列表路由捕获数据库查询异常后返回 `200`、空 `data` 和零计数。前端会把这种失败渲染为 `No users found.` / `No sessions found.`，从接口契约上无法区分真实空数据与查询失败。
- 未构造“被兼容接口过滤”的独立状态，因此该成功标准仍未覆盖。

### 关键响应计量

以下数值由主任务采集，均为单次 server 计量。`durationMs` 不是 TTFB。

| 页面 / 请求 | 响应 bytes | server durationMs | 是否超过 1 MiB |
| --- | ---: | ---: | --- |
| Users 默认 | 911 B | 6.7 ms | 否 |
| Users 筛选 | 357 B | 3.0 ms | 否 |
| Traces core（用户下钻） | 32,473 B | 12.2 ms | 否 |
| Traces metrics（用户下钻） | 74,969 B | 158.4 ms | 否 |
| Sessions 列表 | 15,962 B | 8.8 ms | 否 |
| Session shell | 541 B | 3.7 ms | 否 |
| Session 展开 observations | 53,194 B | 4.4 ms | 否 |
| Scores 默认 | 664 B | 7.2 ms | 否 |
| Scores 过滤空结果 | 70 B | 2.1 ms | 否 |
| Observations summary | 9,380 B | 24.8 ms | 否 |
| Trace shell（observation 下钻） | 667 B | 5.1 ms | 否 |
| Trace observations | 33,329 B | 4.9 ms | 否 |
| Settings keys | 1,946 B | 1.8 ms | 否 |

所列请求全部小于 1 MiB；最大响应为 74,969 B 的 Traces metrics。单次样本不能支持稳定延迟或容量外推。

## 分析

### 事实

- Users 和 Sessions 都能按 environment 提交并 URL 化，也能分别下钻到 Traces 和 session observation tree；但两页没有时间筛选，Users 明确声明其数字为 lifetime usage。
- Users → Traces 保留 `userId`；Sessions 详情使用 sessionId 路径，但不保留列表 environment。
- Scores 和 Observations 有 From/To、environment 与显式 Search；所测 observation 能回到 trace。
- 所测 score 的所有归属引用均为空，UI 显示 `Unlinked`，因此没有可用来源链接；UI 没有进一步解释。
- Settings 删除 dialog 明确即时失效、不可撤销和目标 public key，Cancel 后没有删除。
- Settings 不显示 last-used/expiry；管理接口也没有返回这些已存在于数据库模型中的字段。
- Users/Sessions 的 environment 行查询与 usage 聚合使用不同过滤范围；数据库错误还会被这两个列表转换成 200 空结果。
- 所列关键响应均小于 1 MiB。

### 推断

- 因 Users/Sessions 无时间范围，管理员不能完成“指定时间内核对用户和会话使用量”的核心任务；这不是动作数问题，而是能力缺失。
- 若一个用户或 session 跨环境，当前聚合契约可能让 trace 数看似已按环境缩小，而 observation/token/cost 仍混入其他环境，造成治理口径误读。当前数据影响规模未知。
- `Unlinked` 避免了虚假来源，但没有原因、口径和下一步，使该条 score 的来源核对成为管理死路。
- 删除保护足以降低误删风险，但缺少 last-used、expiry 和 web-ui 自动 key 生命周期说明，会削弱轮换、停用和风险判断。
- Users/Sessions 将查询异常伪装为空结果会让管理员把系统失败误判为“没有使用量”，直接削弱数据可信度。

## 结论

假设仅部分成立，状态为 **DONE_WITH_CONCERNS**。

成立的部分：Users → Traces、所测 Sessions → trace → observation、所测 Observation → Trace 的线性下钻可用；环境筛选可在 Users/Sessions 提交并进入 URL；Scores/Observations 有日期与环境控件；Settings 删除操作具有明确二次确认且取消有效；所有已测关键响应小于 1 MiB。

不成立或未证实的部分：Users/Sessions 没有时间范围，无法完成指定时间核对；它们的环境筛选与 usage 聚合范围并不完全一致；Users/Sessions 查询失败可表现为正常空态；所测 unlinked score 无来源解释或继续调查路径；Settings 缺 last-used、expiry 和自动 web-ui key 生命周期说明。日期/环境的全矩阵恢复、兼容过滤空态、受控失败态及多样本归属链均未完整验证。

本轮不使用“若干动作完成”概括完整任务。短线性下钻成立，不等于指定时间/环境、口径解释和风险治理的完整任务成立。

## 异常发现

### P1：Users/Sessions 无时间范围，核心核对任务不可完成

- **事实**：两页均没有日期控件；前端与 API 参数只声明 userId、environment、分页和排序；Users 明示 `lifetime usage`。
- **推断**：管理员不能回答“某事故窗口/计费周期内某用户或会话用了多少”这一预设任务。
- **范围**：能力缺失已证实；实际业务损失未量化。

### P1：环境筛选与 usage 聚合范围不一致，存在跨环境口径混用

- **事实**：Users/Sessions 的实体/trace 行受 environment 条件约束，但关联 `trace_metrics` 聚合只按 projectId 加 userId/sessionId，没有 environment 条件；session detail 也不保留列表 environment。
- **推断**：同一用户/session 跨环境时，筛选后的 trace 数与 observation/token/cost 可能不是同一统计范围。
- **范围**：查询契约风险已证实；本轮没有跨环境同一对象样本，未量化当前数据集偏差。

### P1：Users/Sessions 查询失败可被伪装为正常空数据

- **事实**：两个 server 列表路由在 DB 异常时均返回 HTTP 200、空数组和零计数；前端据此显示普通空态。
- **推断**：管理员可能把采集/查询故障误判为零使用量，违反“空数据与请求失败可区分”的成功标准。
- **范围**：静态契约事实；未通过受控故障复现 UI。

### P1：Unlinked score 的来源核对是死路

- **事实**：`acc-session-score` 没有 trace/session/observation 引用，UI 只显示 `Unlinked`，无其他来源说明或调查入口。
- **推断**：不能为不存在的引用生成链接，但管理员仍无法判断未关联原因、归属口径或下一步。
- **范围**：只覆盖一个真实 unlinked score，不外推全部 score。

### P1：API key 生命周期信息不足以支持轮换判断

- **事实**：Settings 不显示 last-used 或 expiry；管理 API 不返回这两个字段；浏览器看到 5 条 `web-ui` note，但 UI 不解释自动创建/最多保留 5 个的生命周期。
- **推断**：管理员难以判断哪些 key 活跃、何时到期、删除哪个最安全，以及 web-ui key 为何出现。
- **范围**：信息缺口已证实；未执行任何 key 创建、删除或激活实验。

### P2：Users/Sessions 的提交方式与其他治理页面不一致

- **事实**：Users/Sessions 没有显式 Search，文本通过 Enter 提交；Scores/Observations 提供 Search。
- **推断**：不熟悉 Enter 提交的管理员可能误以为输入即实时生效或找不到提交动作。
- **范围**：Enter 在所测 user/environment 样本有效，因此不是阻断。

### P2：Scores 过滤空态缺少筛选语境

- **事实**：不存在环境仅显示 `No scores found.`，但 Clear 可见。
- **推断**：文案不能直接区分项目无 score 与当前筛选无匹配；Clear 降低但没有消除误解。

未发现 P0。删除确认在所测 key 上通过；没有执行最终删除，因此只验证保护界面和取消路径。

## 下一步建议

1. 为 Users/Sessions 增加 URL 化的 from/to 或统一时间范围，并让标题/列明确数字所属窗口；验证默认、切换、reload、back/forward、Clear 和跨模块传参。
2. 修正 Users/Sessions 聚合，使行数、observations、tokens、cost 都使用同一 environment/time 条件；增加同一 user/session 横跨 `production`、`staging` 的 project-isolation 测试。
3. 不要在 Users/Sessions 查询异常时返回 200 空数据；保留失败状态，让前端显示 Request failed 与 Retry，同时分别测试真实空数据、兼容过滤空态和受控失败。
4. 为无归属 score 增加明确口径：缺失哪些引用、该状态是否允许、可用的 score ID/source/时间，以及可继续检查的入口；不要伪造不存在的链接。
5. Settings 展示 created/last-used/expires/status/note，并解释 `web-ui` key 的自动创建与保留策略；删除确认继续保留具体 public key、即时失效和不可撤销文案。
6. 统一筛选提交模式，或明确提示 Enter 提交；对 Scores 空态显示“当前筛选无匹配”并保留一键清空。
7. 将下一轮浏览器证据落盘为脱敏动作日志、关键 DOM/URL 和网络/server 计量文件；逐行引用证据编号，分开报告浏览器网络 timing 与 server `durationMs`。
