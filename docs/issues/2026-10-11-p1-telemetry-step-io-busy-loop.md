# P1 事故报告：Telemetry 写路径快照读陷入 STEP_IO 空转（CPU 占满、服务不可用）

| 项目 | 记录 |
| --- | --- |
| 事故编号 | P1-2026-10-11-TELEMETRY-STEPIO |
| 严重等级 | P1（服务完全不可用；容器最终被人工 SIGKILL 终止） |
| 发现日期 | 2026-10-11（**同日第二次 telemetry 事件**，第一次为上午 `-tshm`/WAL 事件，见 [2026-10-11-p1-telemetry-tshm-wal-corruption.md](./2026-10-11-p1-telemetry-tshm-wal-corruption.md)） |
| 记录时区 | Asia/Shanghai（UTC+8），关键行附 UTC |
| 当前状态 | 容器已停止（`Exited (137)`），**未恢复**；根因已取证定位，上游无可用修复 |
| 影响服务 | fenix-peri-fuse 部署（`docker/peri-fuse/docker-compose.yml`），全部 API 与控制台 |
| 事故开始／恢复时间 | 约 09:06（01:06Z，首个健康检查超时）起不可用／未恢复；09:28:19（01:28:19Z）容器被 SIGKILL 停止 |
| 数据影响 | 无文件级损坏迹象；被卡事务与强杀时未提交的写入丢失（待恢复后核验），历史数据完整 |
| 涉及版本 | 镜像 `ghcr.io/konghayao/peri-fuse:6ee8504`（运行时 `@tursodatabase/database@0.8.2` + `multiprocess_wal` 实验特性，Node 22 容器镜像） |

## 事故摘要与影响

上午 `-tshm` 事件修复后（08:29:49 启动），服务正常运行约 36 分钟，随后：

- 容器 CPU 接近 100%（单核占满），健康检查连续超时（`Health check exceeded timeout (5s)`，最终 `FailingStreak=38`，状态 `unhealthy`）。
- 所有 HTTP 请求不可用；日志自 09:08:55 起持续出现 `Client connection prematurely closed.`
  （来自 `@hono/node-server@1.19.17`，是客户端因无响应断开的表现，非业务错误）。
- `restart: unless-stopped` 策略不会因 `unhealthy` 自动重启，容器以卡死状态持续约 22 分钟，最后被外部 SIGKILL 停止（ExitCode 137，RestartCount=0）。

根因（已取证）**不在本项目代码**：Turso 0.8.2 驱动在 Node 原生构建下，`get()` 步进循环对一条
**已成功取出行**的写路径快照读持续收到 `STEP_IO`，而 Node 构建下 I/O 等待是 no-op，
循环因此退化为「原生调用 + 已决议 Promise 的 await」的空转热循环（每秒约 80 万次 4 KB 原生读取），
独占主线程，业务与健康检查全部饿死。

## 时间线

以下均为 2026-10-11，北京时间（括号内为 UTC）。

| 时间 | 事件 |
| --- | --- |
| 08:04–08:12（00:04–00:12Z） | 镜像 `6ee8504` 构建（registry label `created=00:04:33Z`；本地镜像 `Created=00:12:07Z`） |
| 08:29:49（00:29:49Z） | 容器启动成功（上午 `-tshm` 事件修复后）：`Peri-Fuse server listening on http://localhost:23332 (mode=lite)`；telemetry 恢复写入 |
| 09:06:38 前后（≈01:06:38Z） | **服务开始不可用**：健康检查首次超时（按 38 次连续失败 × 35s 周期反推） |
| 09:08:55（01:08:55Z） | 第一条 `Client connection prematurely closed.`（至停止共 82 条，持续整段故障期） |
| 09:12:42（01:12:42Z） | 被卡事务中已读出 observation 的 `start_time`；此前写路径仍有极少量推进，之后完全卡死 |
| 09:22–09:25（01:22–01:25Z） | 运行时取证：`SIGUSR1` 打开容器内 inspector，`probe*.mjs` 定位卡死点（见「证据」） |
| 09:27:50–09:28:19 | 数据文件最后写入时间（telemetry 主库 09:27:50、WAL 09:28:08、`-tshm` 09:28:19） |
| 09:28:19（01:28:19Z） | 容器被外部 SIGKILL 停止；现场（含取证脚本）保留在停止的容器中 |

## 已确认的技术原因

### 故障机制（驱动层空转热循环）

1. 卡死的语句是**写路径快照读**，形态统一为
   `SELECT ${mutationSnapshotColumns(table)} FROM ${table} WHERE project_id=? AND id=?`，
   共 5 处调用点共享同一形态：
   [`sqlite-telemetry-adapter.ts:194/250/302/323`](../../packages/shared/src/server/adapters/sqlite-telemetry-adapter.ts)
   （`insert()` / `mergeInsert()` 的 before/after 快照）与
   [`telemetry-mutations.ts:198`](../../packages/shared/src/server/adapters/telemetry-mutations.ts)
   （UPDATE/DELETE 后快照）。现场为 observations 表，列组合
   `id,project_id,trace_id,start_time,type,is_deleted`（[`telemetry-mutations.ts:26`](../../packages/shared/src/server/adapters/telemetry-mutations.ts)）。
2. 驱动侧 `get()` 以 `while(true)` 步进：`STEP_IO` → `await this.io()` → 立即重试
   （`@tursodatabase/database-common@0.8.2/dist/promise.js:1094-1106`）；
   而 `io()` 转发到 `ioStep`，**Node/原生构建下 `ioStep` 是默认 no-op**：
   同文件 L189 `this.ioStep = ioStep ?? (async () => { })`，L583-584 注释明确
   "For in-memory / Node.js builds, ioStep is a no-op since I/O is synchronous"；
   原生包 `@tursodatabase/database@0.8.2/dist/promise.js` 只传 `new NativeDB(path, opts)`，未提供 `ioStep`。
3. 现场该语句**已取出结果行**（见帧内证据）但仍持续返回 `STEP_IO`、永不 `STEP_DONE`
   → 循环没有任何等待/让出点；每秒约 80 万次 4 KB 原生读取，`read_bytes` 增量为 0（全部命中 page cache）。
4. 主线程被该循环占满（3 秒 CPU 采样 98% 位于 native 回调 `custom_gc`，见证据），
   HTTP 与健康检查无法在 5s 超时内完成 → `unhealthy`、全线不可用。

### 为什么永不结束（推断，与上游记录一致）

- 上游 **OPEN** issue `tursodatabase/turso#7211`「Replace step() busy-poll with sleep」（2026-05-21 起）描述同一类行为（原文）：
  > "Currently, step() just busy-loops if the database is locked because of a write transaction,
  > which consumes a lot of CPU for no gain. … the core returns I/O step result, but then at the
  > Rust binding level, we check if there's some busy sleeping needed…"
  其关联修复 PR `#4646` 已**关闭、未合并**；截至 2026-10-11 上游无对应修复版本。
- 结合部署形态（`multiprocess_wal` 实验特性 + 多个连接与后台任务并发写同一库），
  推断触发与写锁竞争下的引擎等待状态有关；具体触发条件未最小复现，需上游确认。
- **已排除**同类但已修复问题：`#8341`（JS 绑定把 `StepResult::Yield` 映射为 `STEP_IO`）的修复提交
  `77689c7467`（2026-08-19，「report StepResult::Yield as STEP_SLEEP instead of STEP_IO」）已包含在 0.8.2——
  `promise.js` 已按 `STEP_SLEEP` 处理，并注释说明「无 I/O 在途的 yield 必须用定时器等待，否则（原生下）会 spin」。
  本次卡住的是真正的 `STEP_IO` 路径，**不是**该问题。`#8171`（wasm/OPFS 同类）与 Node 原生路径无关。

### 与最近代码提交的关系（排除代码回归）

- 快照读语句形态**非本仓库引入**：`6ee8504` 之前即为
  `SELECT * FROM ${table} WHERE project_id=? AND id=?`，该提交仅收窄为显式列
  （引入 `mutationSnapshotColumns()`），并增加 metrics 统计与 `if (!Number(result.changes)) continue;`；
  语句的事务/锁语义未变。
- 卡死位于依赖驱动的步进循环（`promise.js`），不在本仓库代码，且 `git show` 证实
  `6ee8504`/`d744342` 均未触碰驱动或 WAL/共享内存文件操作。

## 证据

### 现场状态（`docker inspect fenix-peri-fuse`）

| 项 | 值 |
| --- | --- |
| 状态 | `Exited (137)`，`StartedAt=2026-10-11T00:29:49Z`，`FinishedAt=2026-10-11T01:28:19Z`，`RestartCount=0` |
| 重启策略 | `unless-stopped`（对 `unhealthy` 不生效） |
| 健康检查 | `fetch(127.0.0.1:23332/api/public/health)`，Interval 30s / Timeout 5s / Retries 3；终态 `unhealthy`，`FailingStreak=38` |
| 镜像 | `ghcr.io/konghayao/peri-fuse:6ee8504`（label `revision=6ee850451318426617043affd0e3fd018be3d3bb`） |
| 数据卷 | bind mount → `docker/peri-fuse/data`（`/app/data`） |

### 日志

- stdout 最后一条业务日志：`2026-10-11T00:29:49.556Z Peri-Fuse server listening on http://localhost:23332 (mode=lite)`
  （此后至停止约 58 分钟无任何业务日志）。
- stderr：82 条 `Client connection prematurely closed.`（01:08:55.978Z – 01:28:08.291Z，全程持续）；
  其余为取证时的 4 次调试器附着记录（`Debugger attached/ending on ws://127.0.0.1:9229/…`）。

### 运行时取证（SIGUSR1 → inspector）

方法：`docker kill -s SIGUSR1` 在容器内 `127.0.0.1:9229` 打开 inspector（仅容器内回环），
用 `docker exec node /tmp/probe*.mjs` 驱动（脚本已复制到宿主机 `/tmp/fenix-container-tmp-20261011/`）。

| 取证 | 结果 |
| --- | --- |
| CPU profile（3 s，500 µs 采样） | 采样总量 3167 ms 中 **3098 ms 归属 native 帧 `custom_gc`**；其余样本集中于 `get@…/database-common/dist/promise.js:1095` |
| 连续 6 次 `Debugger.pause` | **6/6** 停在 `get@…/database-common/dist/promise.js:1095`（`while(true)` 内的 `await stmt.stepSync()`） |
| 断点（promise.js:1095）+ 帧内求值 | db=`/app/data/telemetry.turso.db`；params=`["79f5a440-68a3-40ed-84d8-9b3b5f26be3a","e48eff57d78ca318"]`（project_id, id）；已读行=`{"id":"e48eff57d78ca318","trace_id":"8bf5ea04ddca1c0d5a3d26ffab338129","start_time":"2026-10-11 01:12:42.232","type":"SPAN","is_deleted":0}`——**行已取出，语句仍未结束** |
| 进程 IO 计数 | 读调用 ≈8×10⁵ 次/秒、单次约 4 KB（`rchar` ≈3.3 GB/s）；`read_bytes` 增量 0（全部命中 page cache） |

`custom_gc` 帧的定性依据：同版本原生绑定 `.node` 二进制内含
`Create Custom GC ThreadsafeFunction in napi_register_module_v1 failed`、
`Unref Custom GC ThreadsafeFunction…`、`Failed to unref Buffer reference in Custom GC` 等字符串，
即该帧为绑定在模块注册期创建的 **Custom GC threadsafe function 回调**；
其高占比与该循环每秒数十万次的原生调用/缓冲区引用处理吻合（推断）。

### 数据文件（宿主机 `docker/peri-fuse/data/`）

| 文件 | 大小 | 最后写入 |
| --- | --- | --- |
| `telemetry.turso.db` | 432,701,440 B（≈413 MiB，上午修复时为 276.9 MB） | 09:27:50 |
| `telemetry.turso.db-wal` | 6,769,192 B | 09:28:08 |
| `telemetry.turso.db-tshm` | 86,016 B | 09:28:19 |
| `telemetry.turso.db-shm` | 32,768 B | 02:58:34（上午事件的遗留标准 SQLite 格式文件，未参与本次故障） |

## 版本与升级评估

### 当前锁定版本

`@tursodatabase/database@0.8.2`，三处锁定：
[`packages/cli/package.json:30`](../../packages/cli/package.json)、
[`packages/gateway/package.json:51`](../../packages/gateway/package.json)、
[`packages/shared/package.json:119`](../../packages/shared/package.json)。
npm dist-tags：`latest=0.8.2`、`next=0.8.3-pre.1`（2026-10-08 发布，**预发布**）。

### `v0.8.2...v0.8.3-pre.1` 差异（共 30 个文件）

- 全部为**版本号提升**（`Cargo.toml/lock`、各 bindings 包 `package.json`、`turso-cli` 包）、
  `CHANGELOG.md` 更新，加一个 **sync 引擎**修复
  （`sync/engine/src/database_sync_operations.rs`：schema 操作按事务排序）及配套测试。
- **不包含** step/`STEP_IO`/WAL/锁等待/JS↔原生绑定路径的任何改动。

### 结论

- **升级到 0.8.3-pre.1 不能修复本问题**（且为预发布版本，升级无收益、有引入风险），无必要升级。
- 修复需等待上游处理 `#7211`（OPEN；关联 PR `#4646` 已关闭未合并）。

### 回退 0.7.x 评估（追加核查：源码对比 + 本地对照实验）

**结论：不能解决；实测显示 0.7 更差——它把 0.8 已改为"睡眠等待"的状态重新变回"空转"。**

#### 源码对比（`v0.7.2` vs `v0.8.2`）

| 位置 | v0.7.2 | v0.8.2 |
| --- | --- | --- |
| Rust 绑定 `core->JS` 映射（`bindings/javascript/src/lib.rs`） | `IO \| Yield => STEP_IO`；常量只有 `STEP_ROW/DONE/IO` | `IO => STEP_IO`；**`Yield => STEP_SLEEP(1ms)`**；新增 **`Sleep{duration} => STEP_SLEEP(时长)`** |
| JS 驱动（`database-common`） | `types.js` 无 `STEP_SLEEP`；步进循环只有 `STEP_IO → await this.io() → continue`（无睡眠分支）；`ioStep` 默认 no-op（native 包同样不传） | `STEP_SLEEP` → 定时器等待（`sleepBeforeRetry`）；`STEP_IO` 分支同 0.7（`io()` 在 Node 下仍是 no-op） |
| 核心 `core/busy.rs`（等待锁退避状态机） | 逻辑与 0.8 相同（1/2/5/…/100ms 退避表），但注释写明"让出为 **`StepResult::IO`** 并带 timeout" | 同状态机，注释改为"让出为 **`StepResult::Sleep { duration }`**" |

即：**0.7 里凡"等待/让出"状态（Yield、锁退避）一律上报为 `STEP_IO`，而 JS 层对 `STEP_IO` 是立即重试（无任何睡眠）→ 必然空转**；0.8 才把这些状态拆出来并改为睡眠等待。事故卡死所用的
`IO → STEP_IO → io() no-op → 立即重试` 通道两版**逐行相同**，0.7 没有任何能避免或处理它的机制。

#### 本地对照实验（可复现）

脚本：同进程两条连接（`multiprocess_wal`），A 持有 IMMEDIATE 写事务约 500ms，B 在此期间写同一表，
busy timeout 3s（与生产 `db/local.ts:70` 的 `timeout: 5000` 同语义，仅缩短）。两版各跑两次，结果一致：

| 指标 | 0.7.2 | 0.8.2 |
| --- | --- | --- |
| B 等待耗时 | 3000–3001 ms（超时失败：`database is locked`） | 439–440 ms（**成功写入**） |
| B 等待期间进程 CPU | **2958–2984 ms（100% 空转）** | **3 ms（睡眠等待）** |
| A 的事务时长（同进程） | 3103–3104 ms（被饿死拖慢） | 503–504 ms（正常） |
| 结果行数 | 2（B 的写入丢失） | 3（B 的写入成功） |

0.7.2 在"等待锁"时把 CPU 打满并饿死同进程事件循环（A 的 500ms 定时器被拖到 3100ms 才执行）——
**与事故表现同构**（主线程被占满 → HTTP/健康检查全部超时）；0.8.2 改为睡眠等待，CPU 归零、写入成功。
实验脚本与原始输出保存于 `/tmp/turso-cmp/`（`bench.mjs` 无 timeout 对照、`bench2.mjs` 本次实验、
`out2-*.txt` 结果为两版各两次）。

#### 对本事故的映射

- 事故卡死状态是持续的**真实 `StepResult::IO`**（0.8.2 下 Yield 已被拆走并睡眠，若为 Yield 不会 100% CPU），
  该通道 0.7/0.8 相同 → **若 0.7 的 core 再次进入该状态，表现将与本次完全一致**；0.7 无任何防护。
- 0.7 额外把 Yield 与锁退避并入 `STEP_IO` → 空转触发面**更多**（生产已配置 5s busy timeout，
  锁等待是常态；回退 0.7 会把常态等待变成常态空转，单次最长可占满 5 秒）。
- 上游 `#7211`（2026-05-21 提交，**早于 0.7.0**）描述的正是上述 0.7 行为
  （"step() just busy-loops if the database is locked…consumes a lot of CPU for no gain"）——
  0.8 的 `Sleep{duration}`/`STEP_SLEEP` 就是对该方向的改进。
- 补充：`multiprocess_wal` 在 0.7.2 已是合法实验特性（`ExperimentalFeature` 联合类型已包含），
  上午 `-tshm` 类风险不因回退消失；项目迁移（`9d58ddc`，2026-10-07）即锁定 0.8.2、从未运行 0.7；
  `0.7.2 → 0.8.2` 相隔 2100+ 提交，回退需重跑项目要求的事务/worker/ingestion/SDK 回归。

### 能否用 patch 兜底（追加评估）

**可以，但 patch 只能"降级故障"，不能"修复根因"。**

- 根因不可从 JS 修复：卡死状态是原生 core 的一个未完成等待，JS/原生都没有可用的补救入口——
  原生平台的 IO 泵 `UnixIO::step()` 是空实现（`core/io/unix.rs`），绑定导出的
  `ioLoopSync()` 调用的就是它；即「在 STEP_IO 分支泵一下 I/O 让它完成」这条路不存在；
  驱动 `io()` 在 Node 下 no-op 是设计内行为（"I/O is synchronous"）。
- patch 能做的（`pnpm patch @tursodatabase/database-common@0.8.2`，仓库已有 `patches/` 先例）：
  在约 6–8 处步进循环的 `STEP_IO` 分支加「停滞预算」——连续 IO 超过 N 秒无任何进展（无 ROW/DONE）→
  抛出 `SqliteError`；配合循环 `finally { stmt.reset(); execLock.release(); }` 与事务回滚，
  把「整进程永久冻结」降级为「单次请求失败 +（可能）该连接弃用」；其间可加 1ms 让步避免 100% CPU。
  风险：合法长扫描在返回行之前可能长时间只产生 IO，预算需显著高于最长合法语句的耗时；
  升级依赖时 patch 需重做。
- **免 patch 的官方机制（建议先行）**：`defaultQueryTimeout`（database 级）/
  `queryTimeout`（单语句级）。已实测（0.8.2）：`defaultQueryTimeout: 300` 时，3 亿行递归 CTE
  在 302ms 被以 `statement was interrupted` 中断，正常查询不受影响。
  core 每 256 条指令检查一次 deadline（`core/vdbe/mod.rs` `periodic_checks` → `maybe_request_interrupt`）；
  现场卡死路径仍在高频执行指令（80 万次/s 页读即是证据），故该超时**大概率**能让卡死语句自行中止，
  并由 core 走干净的中断/回滚路径——比 JS 抛错更可靠。
  局限：若卡死落在「不执行指令的完成等待路径」（`finish_pending_io` 的未完成分支），deadline 不会触发
  → 需 JS patch 兜底；两者互补。
- 不值得做的：改原生绑定 `.node`（需自行编译发布链路）；改 0.7（更差，见上节实测）。

### 补丁已落地（2026-10-11 实施，用户决策：仅做驱动 patch）

已按上节设计落地 `@tursodatabase/database-common@0.8.2` 的 pnpm patch
（`patches/@tursodatabase__database-common@0.8.2.patch`，经根 `package.json` →
`pnpm.patchedDependencies` 应用；pnpm install 后以 `_patch_hash=f9fea2…` 副本生效）：

- 实现：覆盖 `dist/promise.js` 全部 8 处 `STEP_IO` 步进循环
  （`Database.exec`、`executeBatch` ×2、`Transaction.exec`、`Statement.run/get/iterate/all`），
  统一接入 `StepIoStallGuard`：
  - 非 `STEP_IO` 结果（ROW / DONE / SLEEP）记为进展并重置时钟 → 正常长查询/流式读取不受影响；
  - 连续 `STEP_IO` ≥ 16 次后，每次 poll 让出 1ms 宏任务（把空转从「独占事件循环」降为「每毫秒一次跳转」）；
  - 连续无进展 ≥ `PERI_FUSE_STEP_IO_STALL_BUDGET_MS`（默认 10000ms）→ 抛
    `SqliteError(message, "SQLITE_INTERRUPT")`，循环 `finally` 正常 reset / 释放锁。
- 验证（全部通过）：
  - 与未打补丁的原版 0.8.2 锁等待对拍（`multiprocess_wal` + `timeout: 3000`，A 持写锁 500ms）：
    patched / 原版结果逐项一致（B 等待 440ms 成功、CPU 3ms、行数 3）；
  - 功能冒烟：CRUD / 事务 / `exec` 多语句 / `batch` / 20 万行递归 CTE 流式读取，全部正常；
  - guard 单元验证：< 16 次连续 IO 零额外开销；病态空转在预算处抛 `SQLITE_INTERRUPT`；持续有进展永不触发；
  - 仓库回归：`@peri-fuse/shared` 298 测试、`@peri/gateway` 143 测试、`pnpm run typecheck`、`pnpm run lint` 全绿。
- 局限（重申）：不能修复根因；真实卡死场景无法在正常环境复现，触发路径以单元验证为准；
  升级 `database-common` 版本时 patch 需重做（`pnpm patch` 会报冲突）。
- 回退：删除 patch 文件与 `package.json` 中 `patchedDependencies` 条目后 `pnpm install`。

## 处置建议（待决策）

1. **恢复服务**：`docker start fenix-peri-fuse`（起后验证 health / CPU / telemetry 写入是否恢复；
   触发条件未消除，存在复发可能，复发时可再次用本文方法取证）。
2. **零补丁自愈（建议先行）**：为 `createLocalDatabase`（[`packages/shared/src/db/local.ts`](../../packages/shared/src/db/local.ts)）
   增加 `defaultQueryTimeout`（如 30–60s，需高于最长合法语句耗时；或经自有驱动包装按语句传入
   `queryTimeout`），让卡死语句被 core 以 `statement was interrupted` 中断（机制与实测见上节）。
3. **运营层防复发**：为容器健康检查增加失败自动重启（如 autoheal 或 supervisor），
   把「永久卡死」降级为「分钟级自动恢复」——本类故障在语言层没有兜底。
4. **跟踪上游** `tursodatabase/turso#7211`；建议基于本次取证向上游提交最小复现
   （写路径快照读 + 多写者 + `multiprocess_wal`）。
5. **评估 `multiprocess_wal` 实验特性的取舍**（同上文件）：
   该特性同时是上午 `-tshm` 事件的相关方；关闭与否需先做并发读取回归，代价与收益待评估。
6. ~~可选（自研缓解，与第 2 项互补）~~ **已实施（2026-10-11，用户决策：仅做驱动 patch）**：
   经仓库 `patches/`（pnpm `patchedDependencies`）机制在驱动 8 处步进循环的 `STEP_IO` 分支加入
   「停滞预算 + 让步」，实施与验证见上节「补丁已落地」。
   注意这**只是缓解/兜底**：覆盖 query timeout 不生效的等待路径，语句仍会失败但进程不再冻结。

## 恢复与回滚

- 恢复：`docker start fenix-peri-fuse`。强杀时未提交事务按 WAL 语义回滚，无文件级损坏预期；
  建议重启后做 `PRAGMA quick_check` + health 验证。
- 回滚：容器/数据侧无修改；驱动补丁的回退方式见「补丁已落地」小节。
- 取证产物：停止的容器内 `/tmp/probe.mjs`–`probe4.mjs`（已复制到宿主机 `/tmp/fenix-container-tmp-20261011/`）；
  容器停止后文件仍保留，可随时 `docker cp` 取出。

## 后续处置与关闭条件

- [ ] 恢复服务并验证（health、telemetry 写入、CPU 平稳）。
- [ ] 决定防复发方案（自动重启 / 驱动补丁 / 等待上游）并落地。
- [x] 驱动补丁已落地（STEP_IO 停滞预算 + 让步）并通过回归（2026-10-11）。
- [ ] 向上游提交最小复现（关联 `#7211`），跟踪修复发布。
- [ ] 决定 `multiprocess_wal` 的去留（结合上午 `-tshm` 事件一并评估）。
- [ ] 关闭条件：服务恢复 + 防复发方案落地 + 上游跟踪有明确结论。

预防重点：**嵌入式数据库驱动在同步 I/O 构建下，任何"等待 I/O"的语义都必须由绑定层实现等待/让出；
一旦绑定层用空转代替等待，上层无从感知，整进程会在一条语句上永久冻结。**
除运营层 watchdog（健康检查自动重启）外，此类故障没有语言层兜底。
