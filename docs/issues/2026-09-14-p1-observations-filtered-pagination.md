# P1 事故报告：Observations 错误记录分页查询性能问题

| 项目 | 记录 |
| --- | --- |
| 事故编号 | P1-2026-09-14-OBSERVATIONS |
| 严重等级 | P1（按本次事故登记要求） |
| 发现日期 | 2026-09-14，用户反馈 |
| 记录时区 | Asia/Shanghai（UTC+8） |
| 当前状态 | 查询层修复及本地验证完成；待发布、待线上复测，事故尚未关闭 |
| 影响服务 | Langfuse Lite Server，Observations V1 列表接口 |
| 事故开始／恢复时间 | 未确认／尚未确认恢复 |
| 线上版本、影响项目数、持续时间 | 待补充 |
| 发布及线上验收负责人 | 待认领 |

## 事故摘要与影响

用户反馈以下接口存在性能问题：

```text
GET http://8.163.76.248:23332/api/public/observations?page=2&limit=25&type=GENERATION&level=ERROR
```

该请求用于分页查看错误的模型生成记录。排查确认，当前查询缺少同时覆盖项目、删除状态、
类型、级别和时间排序的复合索引，精确计数需要额外读取记录检查类型。
已在代码中补充索引，保留 SDK 完整响应和精确分页总数。

**线上影响尚未量化。** 本次未获得该接口的鉴权上下文，远端探测返回 401，未进入业务查询。
线上延迟分位数、超时率、受影响用户数及是否影响其他请求均待确认。
本次没有取得数据丢失、跨项目泄露或全站不可用的证据；P1 登记不代表这些情况已被确认。

## 时间线

以下时间均为 2026-09-14，北京时间；执行时间来自本次测试输出。

| 时间 | 事件 |
| --- | --- |
| 排查开始前，具体时间待补充 | 用户报告指定接口存在性能问题 |
| 排查期间，未记录精确时间 | 远端只读探测返回 401；转为本地数据库及隔离测试验证 |
| 09:20:34 | 新增查询计划回归测试首次运行，2 项失败，确认索引未同时约束 type 和 level |
| 排查期间，未记录精确时间 | 本地真实数据测量；临时数据库对比确认复合索引收益 |
| 09:24:49 | 加入索引后，分页、计数和已有数据库补建索引共 3 项回归测试通过 |
| 09:28:34 起 | Server 完整测试及相关 Shared 测试通过，Server 测试总耗时约 17 秒 |
| 09:30 后 | 按 P1 登记事故报告；修复仍在工作区，尚未提交或部署 |

## 已确认的技术原因

接口同时请求当前页记录和精确总数，任何一条查询变慢都会拖延响应。
本次条件对应的核心 SQL 如下：

```sql
SELECT * FROM observations
WHERE project_id = @projectId AND is_deleted = 0
  AND type = @type AND level = @level
ORDER BY start_time DESC
LIMIT 25 OFFSET 25;

SELECT COUNT(*) FROM observations
WHERE project_id = @projectId AND is_deleted = 0
  AND type = @type AND level = @level;
```

修复前实际执行计划使用：

```text
SEARCH observations USING INDEX idx_obs_error_start
  (project_id=? AND is_deleted=? AND level=?)
```

该索引可按错误级别及时间定位，但不包含 `type`。SQLite 必须额外读取匹配级别的记录，
判断是否为 GENERATION；计数也无法仅访问索引完成。数据分布、缓存和磁盘读取会影响成本。
隔离对比中，刷新 `ANALYZE` 后仍存在这个问题，因此仅更新统计信息不足以解决。

这属于**已确认的查询层瓶颈**，尚不能断言它是线上延迟的全部原因。
默认完整响应中的 input/output/metadata 也是待核实的耗时因素。

## 测量证据及边界

本地遥测数据库文件约 6.4 GiB，其中被测项目有 214,394 条 observation，
满足 GENERATION + ERROR 的记录为 83 条。仅做只读查询，未修改该数据库。

| 测量项 | 结果 | 解释 |
| --- | --- | --- |
| 原索引计数，连续 3 次 | 89.68 / 0.59 / 0.29 ms | 首次观测明显较慢；未清理系统缓存，不作为严格冷缓存基准 |
| 原索引读取第 2 页，连续 3 次 | 7.10 / 3.11 / 2.65 ms | 返回 25 条；不含完整 HTTP 链路耗时 |
| 该页 input/output/metadata 的 UTF-8 字节数合计 | 1,721,349 bytes | 约 1.64 MiB；不是序列化后的完整 HTTP 响应大小 |
| 临时数据库计数中位数，原索引 | 0.166 ms | 预热后 101 次测量 |
| 临时数据库计数中位数，新增复合索引 | 0.009 ms | 预热后 101 次测量，计数结果仍为 83 |

临时数据库仅复制本地 observation 的查询维度列，重建这些列可支持的已有索引，
在同一内存数据库中对比新增索引前后，并刷新统计信息。
**约 18 倍提升仅适用于这组隔离计数测量，不能换算成线上接口整体提升。**
该测量不覆盖完整 payload、网络传输、生产并发或索引构建时的资源消耗。

## 修复及兼容性

在 [telemetry schema 初始化](../../packages/shared/src/server/adapters/sqlite-telemetry-schema.ts)中增加：

```sql
CREATE INDEX IF NOT EXISTS idx_obs_type_level_start
ON observations(project_id, is_deleted, type, level, start_time DESC);
```

新索引让列表按组合条件定位并沿时间顺序分页，使精确计数使用覆盖索引：

```text
SEARCH observations USING COVERING INDEX idx_obs_type_level_start
  (project_id=? AND is_deleted=? AND type=? AND level=?)
```

- 新版启动时幂等补建，适用于已有数据库，无需修改 Prisma schema。
- 保留精确 `totalItems`、`totalPages`、默认完整 SDK 字段及项目隔离。
- 保留现有索引，避免改变其他查询所依赖的索引能力。
- 新索引会增加磁盘及写入维护成本；首次启动需要扫描已有数据建索引，生产开销尚未测量。

已有 `fields=summary` 可减少列表响应传输体积，当前 Web 客户端已显式使用该参数。
它不是本次新增修复，且 V1 当前仍先读取完整行、转换后裁剪响应，不能消除 payload 的数据库读取成本。
用户提供的 URL 未带该参数；应核实线上调用来源及部署版本，不能据此认定所有调用都在使用 summary。

## 验证结果

| 验证项 | 结果 |
| --- | --- |
| Shared 查询回归 | 3 项通过；验证覆盖索引、分页不使用临时排序、项目隔离、删除过滤、越界页及幂等补建 |
| Server 集成测试 | 246 项通过，1 项跳过；包含本次新增的原始 URL 请求及完整／summary 响应兼容性测试 |
| 相关 Shared 测试 | 49 项通过，包含上述 3 项查询回归及 SQLite 读取、摄入、OTLP 路径 |
| Shared 构建、全仓 typecheck | 通过 |
| 本次 3 个代码文件 lint、diff 空白检查 | 通过 |
| 全仓 lint | 未通过：147 个错误，涉及未改动的历史 workflow 文件、生成文件等 |
| 全仓 test | 未通过：Shared 有环境校验、缺失模块引用及 monitor-alert schema 等未改动区域的失败 |

全量测试首次还受到沙箱 IPC 权限限制；允许本地测试端口及 IPC 后重跑，仍存在表中代码／环境问题。
未将完整检查记录为通过，也未扩大本次修复范围处理无关错误。

回归入口：

```bash
pnpm --filter @peri-fuse/shared exec vitest run src/server/repositories/observations-pagination.test.ts
pnpm --filter @peri-fuse/server exec vitest run src/__tests__/observations-pagination.test.ts
```

对应文件：[Shared 查询回归](../../packages/shared/src/server/repositories/observations-pagination.test.ts)、
[Server API 回归](../../packages/server/src/__tests__/observations-pagination.test.ts)。

## 后续处置与关闭条件

- [x] 补充并验证复合索引，锁定查询计划与 SDK 兼容性回归。
- [ ] 发布负责人：记录生产版本及变更版本，部署修复；观察首次建索引的耗时、磁盘和服务启动情况。
- [ ] 线上验收负责人：带鉴权复测原始 URL，记录状态、TTFB、总耗时、响应字节数和缓存状态；不要把鉴权信息写入报告。
- [ ] 线上验收负责人：分别覆盖首次／重复请求和代表性并发，确认计数使用覆盖索引，并比较部署前后的同类样本。
- [ ] 事故负责人：补充影响范围、开始／恢复时间和目标延迟阈值；确认达到阈值后再关闭事故。
- [ ] 后端负责人：若 summary 路径仍有 payload 读取开销，评估在 SQL 层投影列表所需字段，并保持默认 SDK 契约。
- [ ] 质量负责人：另行修复全仓测试与 lint 基线，使未来变更能通过完整检查。

回滚方式：回退到此前应用版本。新增索引不改变数据和响应结构，旧版本可保留该索引运行。
若线上观测确认索引本身造成写入或空间回归，再安排维护窗口移除该索引；本次未对线上执行任何变更。

预防重点：为常用组合过滤、排序和精确计数补充真实 SQLite 执行计划回归，
并把大响应传输与数据库查询分别测量。现有测试缺少对此组合查询访问方式的约束，
仅验证返回记录正确无法发现额外读表带来的性能风险。
