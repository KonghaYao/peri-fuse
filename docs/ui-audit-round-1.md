# Lite Web UI 第一轮走查

状态：完成。已在本地大数据集上完成源码审计、浏览器逐页走查、改进与复测。

## 目标与范围

逐一检查非 Gateway 模块：Dashboard、Traces、Errors、Sessions、Users、Observations、
Scores、Settings。模拟筛选、分页、详情下钻、空态和返回导航，重点评估数据是否可理解、
筛选是否可发现、状态是否可分享和操作是否安全。

## 浏览器场景清单

| 模块 | 场景 | 浏览器证据与结论 |
| --- | --- | --- |
| Dashboard | 切换时间范围；从 Recent errors 下钻 | 选择 7d 后 URL 为 `?range=7d`；Errors 入口存在，状态可分享。 |
| Traces | 环境筛选；列显隐；打开 peek；选择 observation | URL 写入 `environment=default`；先展示 observation 树，选中节点后才出现 Input/Output/Metadata。 |
| Errors | 7d 范围；错误指纹；打开错误并追溯父节点 | 指纹将 URL 写为 `search=provider_or_stream_failure`，35 条命中；详情有 Direct parent、Error evidence、Parent source 和 Open full trace。 |
| Sessions | 列表进入 session；展开 trace | Session shell 先展示 trace，点击 trace 后才展开 observation 树，渐进路径成立。 |
| Users | 用户筛选；进入预筛选 Traces | `userId=KonghaYao` 可恢复，点击用户进入同参数的 Traces。 |
| Observations | 环境/日期筛选；分页 | 首次发现 Search 未提交 Environment；修复后 URL 为 `?environment=default`，Clear(1) 与 25 行分页同步。 |
| Scores | 环境/日期筛选；未关联 score 展示 | 首次列表为空但 Dashboard 有 score trend；确认 v1 丢弃无 trace score，改 v2 后显示 `acc-session-score = 42` 和 `Unlinked`。 |
| Settings | 查看 key；打开删除入口并取消 | 确认框展示具体 public key、立即失效与不可恢复提示；点击 Cancel，没有删除 key。 |

## 批判性结论

1. **筛选提交语义不统一且曾产生错误结果**：Observations/Scores 的 Search 只提交 Name，
   Environment 输入会被忽略；Sessions/Users 仍只依赖 Enter，没有显式提交动作。
2. **同一数据在不同 API 版本下口径不一致**：Dashboard 统计所有项目 score，但旧 v1 列表
   会过滤没有 traceId 的 session/unlinked score，导致“趋势有数据、列表为空”。
3. **Traces 默认信息密度过高**：Input、Output、Metadata、Tags 与 cache 明细同时展开，主任务
   （定位异常 trace）被挤压；原始浏览器语义树约 147k+ 字符，读屏与浏览器处理负担明显。
4. **渐进式下钻总体成立**：Traces、Errors、Sessions 都将完整 IO 延迟到用户选择具体节点后，
   没有在首屏直接展开完整 observation IO。
5. **时间与详情能力仍不完全一致**：Sessions/Users 缺时间窗口；Observations/Scores 的下钻离开
   当前列表上下文，后续可统一成 peek 模式。

## 第一批已执行改进

- Dashboard 时间范围改为 URL 参数，刷新、返回和分享链接不再丢失选择；Recent errors
  增加进入 Errors 工作台的调查入口。
- Observations、Scores 暴露后端原本已支持的环境、起止日期筛选，并沿用现有 URL 表格状态。
- Errors 增加显式 Search 按钮，避免只能依赖 Enter 提交搜索。
- Settings 删除 API key 改为二次确认，确认框展示将失效的 public key，并明确不可恢复。

## 浏览器发现后执行的改进

- Observations、Scores 的 Search 同时提交 Name 和 Environment；修复了输入值被静默忽略的问题。
- Scores 列表切换到项目已支持的 v2 只读接口，展示 session/unlinked score；无 trace 的 score
  显示 `Unlinked`，有 trace 时仍保留下钻链接。
- Traces 默认隐藏 Input、Output、Metadata、Tags、Cached Tokens 和 Cache Hit Rate；高级列仍可在
  Columns 中按需打开。复测时语义树从约 147k+ 字符降到 25,386 字符，且不改变 API 兼容契约。

## 后续候选改进

- 给 Sessions、Users 增加后端时间窗口与前端日期筛选。
- 为 Observation/Score 提供保留列表上下文的详情预览或明确的下钻入口。
- 将窄视口下自动换行的多条件工具栏改成明确的“常用筛选 + 更多筛选”结构。

## 当前验证结果

- `pnpm exec biome check`（本轮改动的 Web 文件）：通过。
- `pnpm --filter @peri-fuse/web run build`：通过。
- `pnpm --filter @peri-fuse/web run typecheck`：未通过；报错全部来自
  `react18-json-view` 的 React 19 / SVG 类型声明（`node_modules`），本轮文件没有新增诊断。
- 浏览器逐页交互与修复后复测：通过；为激活 Default Project，按用户授权创建了一个持久
  `web-ui` API key，未读取或输出 secret，未创建/删除其他业务数据。
