# Lite Web UI 第一轮走查

状态：进行中。源码证据与第一批低风险改进已完成；登录后浏览器证据与最终改进结论待补。

## 目标与范围

逐一检查非 Gateway 模块：Dashboard、Traces、Errors、Sessions、Users、Observations、
Scores、Settings。模拟筛选、分页、详情下钻、空态和返回导航，重点评估数据是否可理解、
筛选是否可发现、状态是否可分享和操作是否安全。

## 浏览器场景清单

| 模块 | 场景 | 通过证据 |
| --- | --- | --- |
| Dashboard | 切换 24h/7d/30d/All；从 Recent errors 下钻 | 范围与数据同步，返回后状态保留 |
| Traces | 名称/用户/环境/日期筛选；列显隐；打开 peek；加载更多 | URL 状态、预览体积、详情按需加载正确 |
| Errors | 范围/消息/类型/模型筛选；错误指纹；父节点调查 | 列表轻量、选择后才取 IO、路径可理解 |
| Sessions | 用户/环境筛选；排序；进入 session；展开 trace | 状态保留、渐进 observation 加载正确 |
| Users | 用户/环境筛选；点击用户进入预筛选 Traces | 筛选可恢复、跨模块参数传递正确 |
| Observations | 名称/类型/级别筛选；分页；进入 Trace | 筛选与分页正确、错误记录易定位 |
| Scores | 名称/来源/类型筛选；分页；进入 Trace | 值/类型语义清晰、筛选可恢复 |
| Settings | key 列表、复制、创建/删除入口 | 密钥操作清晰且危险操作有确认 |

## 源码阶段待证伪假设

1. **时间筛选不一致**：Traces 有起止日期，Dashboard/Errors 有预设范围；Observations 与
   Scores 的 API 已支持时间字段但 UI 未暴露，Sessions/Users 连 API 参数也缺失。
2. **状态可分享性不一致**：表格页使用 URL 状态，Dashboard 使用本地 state，刷新或分享会
   丢失时间范围。
3. **错误调查入口断裂**：Dashboard 展示 error rate 和 recent errors，但没有显著的
   “查看全部错误”入口连接 Errors 工作台。
4. **搜索提交方式不一致**：部分列表显式提供 Search 按钮，Sessions/Users/Errors 主要依赖
   Enter；需要浏览器验证是否造成误解。
5. **数据详情深度不一致**：Traces/Errors/Sessions 有侧栏或详情页，Observations/Scores 只能
   跳到 Trace，用户可能无法保留当前列表上下文。
6. **危险操作确认不足**：Settings 的删除 key 按钮直接触发 mutation，误点恢复成本高。

## 第一批已执行改进

- Dashboard 时间范围改为 URL 参数，刷新、返回和分享链接不再丢失选择；Recent errors
  增加进入 Errors 工作台的调查入口。
- Observations、Scores 暴露后端原本已支持的环境、起止日期筛选，并沿用现有 URL 表格状态。
- Errors 增加显式 Search 按钮，避免只能依赖 Enter 提交搜索。
- Settings 删除 API key 改为二次确认，确认框展示将失效的 public key，并明确不可恢复。

这些调整来自源码阶段可直接证实的问题。浏览器激活本地项目会创建持久 API key，属于凭据创建；
在获得明确授权前不执行该动作，因此以下候选项仍需浏览器实测后排序。

## 后续候选改进（待浏览器验证后排序）

- 给 Sessions、Users 增加后端时间窗口与前端日期筛选。
- 为 Observation/Score 提供保留列表上下文的详情预览或明确的下钻入口。

## 当前验证结果

- `pnpm exec biome check`（6 个改动的 Web 文件）：通过。
- `pnpm --filter @peri-fuse/web run build`：通过。
- `pnpm --filter @peri-fuse/web run typecheck`：未通过；报错全部来自
  `react18-json-view` 的 React 19 / SVG 类型声明（`node_modules`），本轮文件没有新增诊断。
- 登录后的逐页浏览器交互：待授权激活本地项目后执行。
