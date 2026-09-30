# Filter area 扫描与实现记录

## 方法与目标

本轮按「观察 → 仓库扫描 → 数据链路研究 → 实现 → 自动测试 → 人工验证」推进。
研究依据是本仓库页面、请求参数、HTTP schema、SQLite 查询及测试，不依赖外部产品假设。
重点是让用户从已知的用户、会话、模型、发布版本或错误，缩小到真正需要排查的数据。

## 筛选入口清单

| 页面 | 原有筛选 | 本轮增强 |
| --- | --- | --- |
| Traces | 名称、用户、环境、时间 | Session ID、标签、版本、Release |
| Observations | 名称、类型、级别、环境、时间 | Trace ID、User ID、父 Observation ID、版本、模型 |
| Scores | 名称、来源、类型、环境、时间 | Trace ID、User ID、Config ID、数值及比较运算符 |
| Sessions | 用户、环境、时间 | Session ID、单标签 |
| Users | 用户、环境、时间 | 修复多个输入一起搜索与清空草稿行为 |
| Errors | 文本、类型、模型、环境、预设时间 | Trace ID、User ID、Session ID；修复 All time 范围 |
| Dashboard | 预设时间范围 | 自定义起止日期与清空；保留可分享的 URL |
| Gateway request logs | 模型、Provider | 状态、API key 标识、Session ID、最小耗时、起止日期、分页 |
| Gateway error logs | 无独立完整筛选栏 | 模型组、异常类型、HTTP 状态、上游模型、Model ID、API base、日期、分页 |
| Gateway usage | 日期 | API key 标识、模型、Provider；汇总与图表使用同一条件 |
| Gateway models | 无筛选栏 | 模型别名、上游模型、Provider ID、是否启用 |
| Gateway providers | 无筛选栏 | 名称、类型、运行状态、是否启用 |

Session 内容搜索弹窗已支持全文关键词及预设/自定义时间范围，API 另支持返回上限；
本轮保留原有能力，未假造其不支持的身份、角色或标签条件。
详情页、图演示页、Settings、Onboarding 不属于分页数据筛选入口。
Gateway overview 是项目概览，本轮不引入容易误解为全局生效的资源筛选。

## 用户查询路径

- 用户报错：先在 Errors 输入 User ID / Session ID，再用 Trace ID 定位链路。
- 某个模型异常：在 Observations 组合 Model + Level + 时间，查到具体调用。
- 发布后回归：在 Traces 组合 Version / Release + 环境 + 时间。
- 找低质量输出：在 Scores 组合评分名称、类型和 `<=` 数值阈值，再进入 Trace。
- 找慢调用：在 Gateway request logs 输入最小耗时（毫秒），叠加模型或 Provider。
- 排查限流或上游错误：在 Gateway error logs 组合 HTTP 状态与模型组/异常类型。
- 对账：Gateway usage 同时限定 API key、模型、Provider 和日期，避免图表与总额条件不一致。

## 契约与兼容性

- 所有新增后端筛选在分页或聚合前执行；列表与总数使用相同条件。
- 所有查询继续限定当前 projectId；跨 Trace 关联同时限定项目。
- SDK 未传新参数时保持原有响应形状；Observation `model` 是可选扩展。
- ID、版本、Release 和 Observation 模型使用精确匹配；名称等已有文本筛选保留原语义。
- Traces 标签沿用逗号分隔、全部匹配语义；SQLite 成员匹配改用 `json_each`，
  避免 `%`、`_` 和 JSON 引号被误解释。Session 标签是一个完整的字面值，可包含逗号。
- 表格筛选保存在 URL，变更条件重置页码，清空保留无关 URL 状态。
- Search 一次提交所有文本草稿，防止连续更新 URL 丢失部分条件；清空同时清除未提交草稿。
- 可观测性页面日期采用现有日期控件的本地日边界；Gateway 日志日期明确标注 UTC。
- Sessions 的聚合保持现有「符合条件的 Trace 子集」语义，不代表整段会话的无条件汇总。
- API key 筛选使用日志中的标识，不要求填写或暴露 secret key。
- Gateway usage 保留原七日默认范围；清空后显式选择全部时间，刷新不恢复默认。
- Gateway 每日用量表最多显示 200 条匹配聚合行，页面提示该上限；总额与分组汇总不受此限制。

## 自动验证与人工验收

新增覆盖包含组合条件、空结果、精确匹配、零分阈值、特殊字符标签、分页总数、跨项目隔离、
URL 参数、批量提交、分页重置和草稿清空。

本轮验证使用本机 Node.js 22.20.0。默认 PATH 下 Node.js 26 与已安装 better-sqlite3 的
原生 ABI 不匹配，因此通过 `PATH=/usr/local/bin:$PATH` 选择现有 Node 22，不修改依赖。

| 检查 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 全仓通过 |
| `pnpm run lint` | 全仓通过 |
| `pnpm run build` | 全仓通过，含 Web 生产构建 |
| `pnpm run test` | 977 通过、1 跳过：ingestion 165、shared 234、gateway 139、web 75、server 338、MCP 14、CLI 12 |
| `git diff --check` | 通过 |

全部修改及新增文件不超过 500 行；未进行真实数据的人工浏览器验收，留给用户验证。

建议人工验收：

1. 在 Traces 同时填写两项文本筛选，点击 Search，检查 URL 和返回数据均包含两个条件。
2. 在第 2 页修改筛选，确认回到第 1 页；刷新或复制 URL 后条件仍存在。
3. 给一个未提交输入填写内容，再 Clear，确认内容不会被下一次 Search 重新带入。
4. 在 Scores 使用 `<=` 和阈值 `0`，确认零分数据可被查询。
5. 在 Errors 从 User ID → Session ID → Trace ID 逐步缩小范围，并试 All time。
6. 在 Gateway 组合状态/耗时/日期，核对分页总数；usage 核对总额与图表条件一致。
7. 切换项目，确认相同筛选值不会返回另一项目的数据。

## 后续候选（未实现）

- Trace 总耗时、费用、Token 数区间：需要在查询层连接 trace_metrics，统一计数与排序语义。
- 元数据键值、Prompt 名称/版本筛选：需要明确字段类型、缺失值行为与索引策略。
- 保存常用筛选、可发现的候选值和高级筛选折叠：适合人工验收后按真实使用频率排序。
- Gateway overview 的全局筛选：先明确哪些指标应联动，不直接复用局部资源列表条件。

本轮不新增外部基础设施、不迁移数据库结构、不提交 Git commit。
