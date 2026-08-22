# 后台管理员面板可用性实验：第 1 轮

## 基本信息

- 实验主题：生产事故发现与根因调查
- 执行日期：2026-08-22（Asia/Shanghai）
- 实验对象：Default Project，`http://localhost:23433`
- 控制条件：现有本地大数据、桌面暗色视口、不测试 Gateway、不执行业务写操作、不创建 API key
- 目标路径：Dashboard → Errors → fingerprint → error detail → full trace
- 假设：管理员可从 Dashboard 在 4 个主要动作内进入近期错误，按时间和环境缩小范围，查看影响 trace，并沿父节点/完整 trace 找到错误源头。
- 最终状态：**DONE_WITH_CONCERNS**

## 方法

1. 使用当前本地构建及 Default Project 的现有授权状态访问 Dashboard。
2. 按真实管理员调查路径操作：Dashboard → Errors → fingerprint 搜索 → error detail → full trace。
3. 检查时间与环境筛选的可发现性、筛选后的 URL、浏览器后退恢复、Clear filters 清空行为。
4. 记录 Errors 汇总口径、单条错误详情的上下文与根因字段、完整 trace 的父子链。
5. 记录 Dashboard、Errors、trace shell 和 observation 关键接口的响应字节数与 TTFB；不读取响应正文或 secret。
6. 所有操作均为只读，未创建或删除业务数据及凭据。

### 方法偏差

本轮不是完全独立执行：首次尝试由本报告执行者发起，但受本地服务与应用内浏览器可用性阻塞；基础设施恢复后，浏览器动作由主任务按原方案执行并提供原始 DOM、URL、动作和接口计量证据，本报告执行者负责独立整理、区分事实与推断并分级。因证据采集与报告分析由不同执行者完成，结论应理解为基于主任务原始证据的复跑分析，而不是本报告执行者独立复现。

## 原始数据

### 动作路径

| 主要动作 | 页面与 URL | 可见信息 / DOM 证据摘要 | 结果 |
| --- | --- | --- | --- |
| 0（起点） | Dashboard `/dashboard` | `24h`、`7d`、`30d`、`All`；`Error rate`、`Recent errors`、`Investigate all errors` | 调查入口可发现 |
| 1 | 点击 `Investigate all errors` → `/errors` | 默认 `7d`；`290 matching errors`；统计 rail 为 `290 Errors / 96 Affected traces / 16 Signatures` | 进入近期错误列表 |
| 2 | 点击 fingerprint `provider_or_stream_failure` → `/errors?search=provider_or_stream_failure` | fingerprint 显示 `35 hits · 28 traces`；筛选后 `35 matching errors`；存在 `Clear filters` | 按签名缩小范围 |
| 3 | 点击第一条 `step-1`、`GENERATION`、`provider_or_stream_failure` | `Direct parent`、`Error evidence`、`Parent source`、`Open full trace` 各 1；user/session 文本可见；所选 `errorId` 未进入 URL | 查看单条错误证据与父来源 |
| 4 | 点击 `Open full trace` → `/traces/01a0100e6bcd7bd2ac058132c953a7fe` | heading 为 trace name；存在 `Observation tree`；树含 `agent-run`、`stage-reason ERROR`、`step-1 ERROR` | 到达完整 trace 并看到错误链 |

从 Dashboard 调查入口算起，完成根因下钻使用 4 个主要动作。Dashboard 本身计为起点，不计入点击动作。

### 筛选与 URL 状态

| 检查项 | 原始结果 |
| --- | --- |
| Dashboard 时间选项 | `24h`、`7d`、`30d`、`All` 均存在 |
| Errors 默认时间 | `7d` |
| Errors 默认 URL | `/errors`，默认时间未显式写入 URL |
| fingerprint 搜索 URL | `/errors?search=provider_or_stream_failure` |
| 类型与模型筛选 | `All types`、`All models` 存在 |
| 环境筛选 | environment textbox 数量为 0，未发现环境控件 |
| 浏览器后退 | 从 full trace 后退到 `/errors?search=provider_or_stream_failure`，fingerprint 搜索恢复 |
| 清空筛选 | 点击 `Clear filters` 后为 `/errors?range=7d`，恢复 `290 matching errors` |
| 错误详情选择 | 所选 `errorId` 未写入 URL；后退后不恢复选中项 |

### 影响范围与根因证据

- Errors 全局 rail：`290 Errors / 96 Affected traces / 16 Signatures`。
- fingerprint `provider_or_stream_failure`：`35 hits · 28 traces`。
- fingerprint 筛选后：`35 matching errors`。
- 单条详情可见 user/session 文本，并提供 `Direct parent`、`Error evidence`、`Parent source` 与 `Open full trace`。
- 完整 trace 的 Observation tree 显示 `agent-run` → `stage-reason ERROR` → `step-1 ERROR`，能够沿完整 trace 观察错误节点链。
- 原始证据未显示 fingerprint 汇总层面的 user/session 影响分布。

### 关键接口计量

以下均为缓存 `MISS` 时的原始计量：

| 页面 / 请求 | 响应字节 | TTFB | 是否超过 1 MiB |
| --- | ---: | ---: | --- |
| Dashboard | 5,992 B | 25.7 ms | 否 |
| Errors 默认列表 | 23,488 B | 11.5 ms | 否 |
| Errors fingerprint 筛选 | 17,490 B | 20.2 ms | 否 |
| Trace shell | 665 B | 9.2 ms | 否 |
| v2 observation 请求 1 | 267,966 B | 10.5 ms | 否 |
| v2 observation 请求 2 | 1,330 B | 8.2 ms | 否 |
| v2 observation 请求 3 | 4,717 B | 4.4 ms | 否 |

本路径首屏和关键接口均未触发 `>1 MiB` 响应。最大的已观测响应是 267,966 B 的 v2 observation 请求。

### 空态与错误态文案

本次数据路径均有结果，未触发产品空态或请求失败态，因此没有足够证据评价“无数据”“兼容接口过滤”“请求失败”三类状态的文案区分。

## 分析结果

### 事实

- 4 个主要动作可以从 Dashboard 的显式入口到达错误 fingerprint、单条详情和完整 trace。
- Dashboard 与 Errors 都提供时间范围，Errors 默认使用 7d；后退可恢复 fingerprint 搜索，Clear filters 会生成显式 `/errors?range=7d`。
- Errors 没有可见的 environment textbox；现有筛选仅观察到类型和模型控件。
- Errors 提供错误数、affected traces 和 signatures；fingerprint 行提供 hits 和 traces。
- user/session 只在本次单条详情证据中可见，未在 fingerprint 汇总证据中看到影响分布。
- 单条错误详情包含直接父节点、错误证据、父来源与完整 trace 入口。
- 所选错误未写入 URL，浏览器后退后不恢复详情选中项。
- 所有已测关键接口均小于 1 MiB。

### 推断

- 缺少环境筛选会阻止值班管理员按生产/预发等环境缩小事故范围，因此假设中的“按环境缩小范围”不成立。
- affected traces 和 signatures 足以给出总体影响轮廓，但缺少 fingerprint 汇总层面的 user/session 影响信息，可能增加判断业务影响面的二次下钻成本。
- 详情选择不 URL 化会削弱可分享、可刷新、可恢复的调查上下文；它不阻断当前线性路径，但不利于交接和值班协作。
- Observation tree 与详情父来源共同提供了可用根因链，但本轮仅验证一个真实样本，不能外推所有错误类型都具有同等完整的父链。

## 结论

状态为 **DONE_WITH_CONCERNS**。假设部分成立：管理员能在 4 个主要动作内从 Dashboard 到达完整 trace，看到 fingerprint 影响 trace 数、单条错误证据、直接父节点和完整 Observation tree；时间默认 7d，fingerprint 搜索可通过 URL 和浏览器后退恢复，筛选可清空。

假设的环境部分不成立：Errors 未发现环境筛选控件，无法按环境缩小范围。此外，所选 error detail 不进入 URL，后退不能恢复选中项；影响范围虽包含 traces/signatures，但 fingerprint 汇总层面缺少已证实的 user/session 分布。上述问题不阻断单人线性调查，但削弱生产事故的范围判断、交接与上下文恢复。

## 异常与发现

### P1：Errors 缺少环境筛选，无法完成假设要求的环境收窄

- 类型：产品调查能力缺口。
- 事实：Errors 页面存在 `All types` 和 `All models`，environment textbox 数量为 0；本轮未发现其他环境控件。
- 推断：当同一错误签名横跨生产与非生产环境时，管理员无法在 Errors 内可靠分离事故范围。
- 影响：假设中的核心步骤“按时间和环境缩小范围”只完成了时间部分。

### P2：所选错误详情不进入 URL，调查上下文不可完整恢复

- 类型：可恢复性与协作摩擦。
- 事实：fingerprint 搜索写入 URL，但所选 `errorId` 未写入 URL；从 full trace 后退仅恢复搜索，不恢复详情选中项。
- 推断：刷新、复制链接或交接给其他值班人员时，需要重新定位同一条错误。
- 影响：不阻断根因调查，但增加重复操作并削弱分享精度。

### P2：fingerprint 汇总的业务影响信息有限

- 类型：信息密度与影响判断摩擦。
- 事实：全局 rail 提供 errors、affected traces、signatures；fingerprint 提供 hits 和 traces；user/session 文本只在本次单条详情中可见。
- 推断：管理员可能需要逐条下钻或转到其他模块，才能判断受影响用户/会话范围。
- 影响：延长事故影响评估，尤其在同一签名涉及大量 traces 时。

### 未覆盖：空态与错误态区分

- 类型：证据缺口，不分产品优先级。
- 事实：本次路径有真实数据，且关键请求均成功，未触发空态或失败态。
- 影响：无法评价规划中三类状态文案的可解释性。

### 首次尝试：基础设施阻塞

- 类型：实验异常，非产品可用性结论。
- 事实：首次尝试时 `23332`、`23432`、`23433` 均无可复用实例；受限环境不允许 server 监听 `0.0.0.0:23433`，且普通启动维护流程尝试对 telemetry SQLite 执行 `ANALYZE`；应用内浏览器随后也暂时不可用。
- 处置：主任务解除本地服务阻塞并完成浏览器原始证据采集；最终结论只使用复跑证据，不把首次连接失败当作产品问题。

未发现 P0。

## 下一步建议

1. 为 Errors 增加可发现、URL 化且可清空的环境筛选，并用至少两个环境的真实数据验证计数与 project isolation。
2. 将选中的 error detail 标识写入 URL；验证刷新、复制链接、浏览器后退/前进都能恢复 fingerprint 与具体错误。
3. 在 fingerprint 汇总层提供受影响 user/session 数或明确的下钻入口，并说明未关联 user/session 的口径。
4. 补充空态、兼容过滤空态与请求失败态的独立实验，验证三者文案和下一步指引可区分。
5. 修复后由独立 verifier 复测同一路径；需特别检查环境参数与 error 标识不会跨 Default Project 泄漏或恢复错误对象。
