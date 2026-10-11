# P1 事故报告：Turso 查询规划器缺统计导致 Telemetry 点查退化为全 project 扫描（CPU 占满）

| 项目 | 记录 |
| --- | --- |
| 事故编号 | P1-2026-10-11-TURSO-PLANNER-STATS |
| 严重等级 | P1（容器 CPU 单核占满、HTTP 严重降级；**未停机**，在线完成修复） |
| 发现日期 | 2026-10-11 上午（**同日第三次 telemetry 事件**；前两次见 [STEP_IO 空转](./2026-10-11-p1-telemetry-step-io-busy-loop.md) 与 [`-tshm` WAL 事件](./2026-10-11-p1-telemetry-tshm-wal-corruption.md)） |
| 记录时区 | Asia/Shanghai（UTC+8），关键行附 UTC |
| 当前状态 | **已恢复**（生产库 `ANALYZE` + 容器重启后 CPU 0.14%，服务正常）；自愈机制已随代码落地 |
| 影响服务 | fenix-peri-fuse 部署（镜像 `ghcr.io/konghayao/peri-fuse:4d96d96`），HTTP 全部降级至秒级 |
| 数据影响 | 无。修复前后行数只增不减（observations 10,775 → 11,523+），`freelist_count=0`，无回滚/丢数据 |
| 涉及版本 | `@tursodatabase/database@0.8.2`（patched，含 STEP_IO stall guard）+ `multiprocess_wal` |

## 事故摘要与影响

STEP_IO 驱动补丁（`4d96d96` 镜像）上线后，容器再次出现 CPU 接近单核 100%、HTTP `health` 从毫秒级降至 **10.5s**、`/proc/1/io` 读放大（`rchar` +2.9 GB/s、`syscr` 71 万次/s）。

与上一次 STEP_IO 空转不同，本次**查询在持续推进但每次代价畸高**（stall guard 未触发是设计内正确行为）：断点显示两条并发点查以 ~85ms/轮的节奏交替步进。取证将根因隔离到**一条 SQL 与查询计划的选择**：

```sql
SELECT id, project_id, trace_id, start_time, type, is_deleted
FROM observations WHERE project_id=? AND id=?
```

当数据库**没有可用统计信息**（`sqlite_stat1` 缺失）时，Turso 规划器选择 `idx_obs_type_level_start (project_id, ...)` —— 只按 `project_id` 做前缀 seek，再对全部 **11,523 行逐行过滤 `id`** 并回表读取整行（平均 36 KB，含大 blob），每次点查产生 **≈382 MB 读放大**。该查询以约 7.6 次/s 的频率执行（ingestion 快照读路径），恰好等于 2.9 GB/s 读与 100% 单核 CPU。

根因**不在本项目代码**：上游 Turso 规划器把 composite PRIMARY KEY 的单个组成列错误地按 unique 列估值（无统计时 fallback ≈ 1/100 万行），使二级索引前缀扫描的成本被低估、在 tie-break 中胜出。上游同一 bug 已有 Open issue：[tursodatabase/turso#8664](https://github.com/tursodatabase/turso/issues/8664)。

## 关键证据

| 证据 | 结果 |
| --- | --- |
| 容器 CPU | 100.25%（线程采样：仅主线程 node 燃烧，3s 窗口 Δ≈1003% 单线程） |
| `/proc/1/io` 增量（2s） | `rchar +2.9 GB/s`、`syscr +710,673/s`、`write_bytes +1.55 MB/s`（tshm/shm 写） |
| HTTP `/api/public/health` | **10.5s**（修复后 19ms） |
| CPU profile（2s） | 1713.7ms 在 native `custom_gc`；调用链 `get@database-common/dist/promise.js`（patched 行号 1153） |
| `stall.wait()` 断点（6s） | **零命中** —— 不走 STEP_IO 分支（有进展，guard 正确） |
| `stepSync()` 断点 | 每 ~85ms 命中一次；参数为 obs 点查（`[projectId, obsId]`）与 ifv 查询（`[projectId, 'observations', obsId]`）交替 |
| 副本 `EXPLAIN QUERY PLAN`（无统计） | `SEARCH observations USING INDEX idx_obs_type_level_start (project_id=?)` → 86-94ms/次 |
| 副本 `ANALYZE` 后 | `SEARCH observations USING INDEX sqlite_autoindex_observations_1 (project_id=? AND id=?)` → **0ms** |
| 强制索引对照 | `INDEXED BY sqlite_autoindex_observations_1` → 0-1ms；其余 7 个索引均 ~90ms |
| 请求量对照（事件时间分钟分布） | 故障期 ≈70 obs/min vs 修复后 ≈73 obs/min —— **外部请求没有减少** |
| 数据对照 | 行数只增（10,775 → 11,523+）、文件尺寸只增（458 MB → 487 MB+）、`freelist_count=0` |

## 根因（上游机制）

Turso 0.8.2 规划器源码链（引用上游 `main` 分支文件）：

1. [`core/translate/optimizer/constraints.rs`](https://github.com/tursodatabase/turso/blob/main/core/translate/optimizer/constraints.rs)
   的 `estimate_selectivity`：对 `=` 约束，rowid/rowid-alias 之外**只要 `column.primary_key()` 为真就套用 unique 公式 `1/行数`** —— 没有区分「单列 PK」与「composite PK 的组成列」。无统计时退化为 `1/fallback`（≈1e-6），`project_id=?` 被估成约 1 行（实际 11,523 行）。
2. 因此只约束第一前缀的二级索引 `idx_obs_type_level_start (project_id, ...)` 获得了与完整 PK 索引 `(project_id, id)` 相近的 seek 成本。
3. [`core/translate/optimizer/cost.rs`](https://github.com/tursodatabase/turso/blob/main/core/translate/optimizer/cost.rs) 的 `is_unique_point_lookup` 只在候选成本已算出后起作用，无法反向修正错误的 selectivity。
4. [`core/translate/optimizer/access_method.rs`](https://github.com/tursodatabase/turso/blob/main/core/translate/optimizer/access_method.rs) 的 `choose_best_btree_candidate` 在成本接近时以 residual selectivity 打破平局：二级索引把 `id=?` 当作剩余高选择性过滤 → 输出更小 → **胜出**。

### 为什么 ANALYZE 能修复

[`core/translate/analyze.rs`](https://github.com/tursodatabase/turso/blob/main/core/translate/analyze.rs) 为**每个索引**写入一行 `sqlite_stat1`（形如 `500 500 1` = 总行数 + 各前缀平均行数）。`cost.rs` 的 `estimate_rows_from_analyze_stats` 按等值前缀长度取数：二级索引只能取第一前缀 → 估出真实重复度（数百至数千行）；PK 索引取完整两列 → 估 1 行。成本翻转，PK 胜出。

**空表 ANALYZE 无效**：空表不写 `sqlite_stat1` 条目（与原生 SQLite 一致），因此「建表/迁移时 ANALYZE」是 no-op —— 必须在**表已有数据之后**执行。

### 统计老化

实验：500 行时 ANALYZE 后灌至 20,500 行（老化 40 倍），计划保持正确不退化。判据上仍按「per-index 条目缺失或行数估计为 0」判无效。

## 处置与验证

1. 生产库在线执行 `ANALYZE`（首次 5s busy timeout 因写锁竞争失败；60s timeout 下 17s 成功，写入 `sqlite_stat1`）。
2. `docker restart`（跨进程 ANALYZE 不会刷新**运行中进程**已编译的计划 —— 已实验证明必须重启）。
3. 验证：CPU **100.25% → 0.14%**；`rchar` 2.9 GB/s → 5.9-7.7 MB/s（↓~400x）；`syscr` 71 万/s → 1.4-1.9k/s；health 10.5s → **19ms**；启动无 panic、无 error/warn 日志。

## 代码修复（自愈，已落地）

`packages/shared/src/db/query-statistics.ts`：

- `ensureQueryStatistics(db)`：枚举用户表 → 读 `sqlite_stat1` 判定「**per-index** 条目存在且行数估计 > 0」→ 对无有效统计**且非空**（`SELECT 1 ... LIMIT 1` 探测）的表执行**表级** `ANALYZE <table>`；空表跳过、内部表（`_` 前缀）跳过、单表失败静默重试。
- `startQueryStatisticsMaintenance(db)`：启动立即一轮 + 每 10 分钟一轮（统计就位后每轮为只读、近零成本）；timer `unref`，返回停止函数。

接线（均为读写连接；只读 read-pool 不涉及）：

- [`sqlite-telemetry-adapter.ts`](../../packages/shared/src/server/adapters/sqlite-telemetry-adapter.ts)（telemetry 库）
- [`db/client.ts`](../../packages/shared/src/db/client.ts)（langfuse metadata 库）
- [`gateway/src/db.ts`](../../packages/gateway/src/db.ts)（gateway 库）

回归测试 [`query-statistics.test.ts`](../../packages/shared/src/db/query-statistics.test.ts)：① 非空+无统计 → ANALYZE 且点查计划恢复 `sqlite_autoindex_obs_1`；② 空表跳过；③ 已有统计与内部表在后续轮次跳过。

## 跟踪项（上游）

- [#8664 Planner drops composite-PK seek for secondary index](https://github.com/tursodatabase/turso/issues/8664) —— **Open，无合并修复**；候选修复可能把问题转移到 [#8322](https://github.com/tursodatabase/turso/issues/8322)（FROM-subquery/coroutine 改写路径）。
- [`PRAGMA optimize` 自动统计维护](https://github.com/tursodatabase/turso/issues/656) —— 在 1.0 milestone；当前为 no-op（已实测），故本修复不依赖它。
- [#6299](https://github.com/tursodatabase/turso/issues/6299) / [#6289](https://github.com/tursodatabase/turso/issues/6289) —— ANALYZE 写入多余 NULL-idx 行的已知差异（本判据只认 per-index 行，不受影响）。
- 版本沟通：GitHub 最新正式 release 为 0.8.1（2026-09-29），本地 0.8.2 未见对应 tag；升级前需先核对上游 commit。

## 复现（本地最小化）

```sql
CREATE TABLE obs (id TEXT NOT NULL, project_id TEXT NOT NULL, v TEXT, payload BLOB,
                  PRIMARY KEY (project_id, id));
CREATE INDEX idx_obs_project_v ON obs (project_id, v);
-- 插入数百行后：
EXPLAIN QUERY PLAN SELECT id, project_id, v FROM obs WHERE project_id=? AND id=?;
--   无统计  → SEARCH obs USING INDEX idx_obs_project_v (project_id=?)
--   ANALYZE 后 → SEARCH obs USING INDEX sqlite_autoindex_obs_1 (project_id=? AND id=?)
```

## 剩余风险

- 自愈机制依赖 10 分钟周期与表非空判据；若上游规划器在**有统计**时仍有其他形状的错误（#8664 的 join/子查询变体），本修复不覆盖 —— 届时需要计划验证/告警层。
- 与 `multiprocess_wal` 的启动期 panic（reader slot 非属主释放）为**独立问题**，见 `-tshm` 篇，仍待单独跟进。
