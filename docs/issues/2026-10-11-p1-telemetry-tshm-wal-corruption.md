# P1 事故报告：Telemetry 库 -tshm 共享内存与 WAL 不一致导致容器启动崩溃循环

| 项目 | 记录 |
| --- | --- |
| 事故编号 | P1-2026-10-11-TELEMETRY-TSHM |
| 严重等级 | P1（服务完全不可用，容器崩溃循环） |
| 发现日期 | 2026-10-11，用户报告「容器启动不了」（08:23 部署新镜像时明确暴露） |
| 记录时区 | Asia/Shanghai（UTC+8） |
| 当前状态 | 已修复，容器恢复 healthy；防复发加固待认领 |
| 影响服务 | fenix-peri-fuse 部署（pazhou/remote-control-server，`docker/peri-fuse`），全部 API 与控制台 |
| 事故开始／恢复时间 | 约 2026-10-11 02:16（telemetry 最后一次成功写入）／08:29:49（修复后启动成功） |
| 数据影响 | **零丢失**（已验证）；期间 Agent 上报的 Trace 丢失（上报失败不阻塞业务，属既有边界） |
| 涉及版本 | 镜像 `ghcr.io/konghayao/peri-fuse:6ee8504`（运行时 `@tursodatabase/database@0.8.2`，`multiprocess_wal` 实验特性） |

## 事故摘要与影响

部署侧（`docker/peri-fuse/docker-compose.yml`，容器名 `fenix-peri-fuse`）重新部署新镜像后，容器进入
**崩溃循环**（`Restarting (1)`，约每 1–2 秒重启一次），服务完全不可用。日志中的致命错误：

```text
[lite-server] Fatal startup error failed to open database /app/data/telemetry.turso.db:
I/O error: short read on WAL frame at offset 1829312: expected 4096 bytes, got 0
```

- `gateway.turso.db`、`langfuse.turso.db` 均正常打开，仅 `telemetry.turso.db` 打不开。
- 该错误在打开阶段即发生，服务无法进入监听状态；健康检查从未通过。
- 从 02:16 起数据停止写入，至 08:29 修复，服务实际不可用约 6 小时 15 分。
- 修复后已验证：主库数据完整（observations 6771 条 / traces 48 条，与损坏态一一对应），
  最后一条数据仍为 2026-10-11 02:15:49（北京时间），**无任何历史数据丢失**。

## 时间线

以下均为 2026-10-11，北京时间。执行时间来自容器日志与本次诊断命令输出。

| 时间 | 事件 |
| --- | --- |
| 10-10 16:39 | 部署数据目录初始化（`langfuse.turso.db` / `gateway.turso.db` / `.salt` 等创建） |
| 02:15:49 | telemetry 最后一条 observation 成功写入 |
| 02:16 | telemetry 主库与 `-wal` 文件时间戳更新：WAL 内容被 checkpoint 进主库，WAL 被截断为 0 字节；`-tshm` 未同步（**损坏形成点**）。同一时段容器正处于「CPU churn／Bun 崩溃」的修复工作中（对应提交 `d744342`） |
| 02:36 / 03:38 | 提交 `d744342`（prevent Docker CPU churn and Bun runtime crashes）、`6ee8504`（reduce telemetry and gateway hot-path work）；两者均未触碰 WAL／共享内存文件管理（**与损坏无直接因果**） |
| 02:58 | 数据目录中出现标准 SQLite 格式的 `telemetry.turso.db-shm`（32 KB）。操作者与工具未确认（可能是排查期间的验证／检查操作） |
| 08:04 | 部署镜像 `6ee8504` 构建完成 |
| 08:23 | 容器启动，立即进入崩溃循环；日志报 `short read on WAL frame` |
| 08:24–08:26 | 诊断：定位错误文件；在**副本**上做隔离实验（见下），确认仅删除 `-tshm` 即可恢复，且数据零丢失 |
| 08:28–08:29 | 停止容器；完整备份现场至 `docker/peri-fuse/backup-20261011-0830/`；将损坏的 `-tshm` 移出数据目录 |
| 08:29:49 | 容器启动成功：`Peri-Fuse server listening on http://localhost:23332 (mode=lite)`，无 Fatal |
| 08:30 | 验证：health 200、SPA 200、telemetry 主库/WAL/tshm 文件恢复活跃写入 |

## 已确认的技术原因

### 故障机制（可复现）

本项目本地数据库运行在 `@tursodatabase/database@0.8.2`，通过
[`LOCAL_DATABASE_OPTIONS`](../../packages/shared/src/db/local.ts) 开启实验性多进程 WAL
（`experimental: ["multiprocess_wal"]`）。该模式使用自有共享内存文件 `*.db-tshm`
（魔数 `TSHMWAL`）记录 WAL 帧索引，**不使用** SQLite 标准的 `*.db-shm`。

损坏现场的文件组合：

| 文件 | 状态 | 含义 |
| --- | --- | --- |
| `telemetry.turso.db` | 276,914,176 B，02:16 | 主库完整，checkpoint 已吸收全部数据 |
| `telemetry.turso.db-wal` | **0 B**，02:16 | WAL 已无任何有效帧 |
| `telemetry.turso.db-tshm` | 167,936 B，持续被重写 | 索引仍声称 WAL 存在约 1.8 MB 帧（错误指向 offset 1829312） |
| `telemetry.turso.db-shm` | 32,768 B，02:58 | **标准 SQLite 格式**（双 48 字节 WalIndexHdr 布局），非 Turso 文件 |

即：**某个进程把 WAL 内容 checkpoint 进主库并把 WAL 截断为 0，但没有同步 Turso 的 `-tshm` 索引**。
此后每次打开，驱动按陈旧索引去 0 字节 WAL 找帧 → `short read` → 拒绝打开 → 容器崩溃循环。

### 诱因分析（无法 100% 锁定，两个候选）

1. **标准 SQLite 引擎的工具访问过该库**：`sqlite3` CLI、`node:sqlite`、Python `sqlite3`
   或任何内置标准 SQLite 的工具，在关闭连接时会把 WAL checkpoint 进主库并截断/清理 WAL；
   它不认识 `-tshm`，不更新索引。现场标准格式的 `-shm` 与该模式吻合。外部曾有同构问题记录
   （oh-my-pi issue #12231：标准 SQLite 工具访问 Turso 协调的库导致 `short read on WAL frame`）。
2. **进程在 checkpoint 中途被强制中断**：02:16 正处于容器「CPU churn／Bun 崩溃」的修复时段
   （`d744342` 所修复的问题），若 Turso 自身的 checkpoint 在「截断 WAL 之后、同步 `-tshm` 之前」
   被杀，会留下同样状态。

两者均属**运行时／操作层面**诱因；现有材料（无操作审计日志）不足以进一步区分。**可排除**：最近两次
代码提交（`d744342`、`6ee8504`）不含任何 WAL／共享内存文件操作，不是损坏的来源。

### 暴露的产品缺陷

- `multiprocess_wal` 为实验特性，对「`-tshm` 与 WAL 不一致」**没有任何自愈能力**：一旦进入该状态，
  服务永久无法启动，且报错只指向文件内部偏移，无操作指引。
- 项目文档未警告「禁止用标准 SQLite 工具直接打开 `*.turso.db`」。

## 证据与实验

全部实验在**副本**上进行，未改动生产数据。（macOS arm64 / Node v26.9.0；容器闭环实验为
`linux` / Node v22.23.3 / 同版本驱动。）

### 副本隔离实验（定位损坏文件）

| 实验 | 操作 | 结果 |
| --- | --- | --- |
| A | 原样打开 | 复现 `short read on WAL frame at offset 1829312` |
| B | 仅删 `-shm` | **仍失败**（排除 `-shm` 为直接原因） |
| C | 删 `-shm` + `-tshm` | 打开成功 |
| D | 再删 0 字节 `-wal` | 打开成功（WAL 本无数据，删与不删等价） |
| E | **仅删 `-tshm`** | 打开成功；重复打开幂等稳定；驱动自动重建 `-tshm` |

### 容器内闭环实验（复现「标准 SQLite 访问」行为）

模拟受污染的完整链路：Turso 写入 100 行（WAL ≈ 1 MB）→ `node:sqlite` 打开并关闭 → Turso 重新打开。

- `node:sqlite` 关闭时：主库从 4 KB 膨胀到 212 KB（checkpoint 生效），**WAL 与标准 `-shm` 被删除**。
- 该「干净关闭」组合下 Turso 可正常恢复并重建；说明只有当 WAL 文件**保留但为 0 字节**、
  或访问进程**未正常收尾**时，陈旧 `-tshm` 才会导致永久性 `short read`。

### 数据完整性验证

| 验证项 | 损坏态副本 | 修复后副本 |
| --- | --- | --- |
| `PRAGMA quick_check` | ok | ok |
| observations | 6771 | 6771 |
| traces | 48 | 48 |
| 最后写入时间 | 2026-10-10 18:15:49Z | 同上（无变化） |

## 修复过程与验证

修复动作（最小干预，主库与 WAL 未做任何修改）：

```bash
docker stop fenix-peri-fuse
# 备份现场（含损坏的 tshm 副本）到 docker/peri-fuse/backup-20261011-0830/
cp -p data/telemetry.turso.db{,-wal,-shm} backup-20261011-0830/
mv data/telemetry.turso.db-tshm backup-20261011-0830/telemetry.turso.db-tshm.corrupt
docker start fenix-peri-fuse
```

修复后验证：

| 验证项 | 结果 |
| --- | --- |
| 容器状态 | `Up (healthy)` |
| `/api/public/health` | HTTP 200 |
| 控制台 SPA（自带 `Accept: text/html` 的浏览器请求） | HTTP 200 |
| 启动日志 | 无 Fatal，`Peri-Fuse server listening` |
| 数据文件 | 主库增长（276.9 MB → 280.0 MB）、WAL 重建至 1.4 MB、`-tshm` 重建为 86 KB（活跃写入恢复） |

## 回滚方式

如需回到损坏前现场：`docker/peri-fuse/backup-20261011-0830/` 内含四个文件的完整副本
（`telemetry.turso.db`、`-wal`、`-shm`、`tshm.corrupt`）。恢复方式：停容器后整目录拷回并
恢复 `tshm.corrupt` 原名。注意：该现场为不可打开状态，仅作取证与比对用途。

## 后续处置与关闭条件

- [x] 恢复服务：移走陈旧 `-tshm`，容器启动成功、健康检查通过。
- [x] 数据完整性验证：行数与最后写入时间比对一致，零丢失。
- [x] 保留现场：损坏 `-tshm` 备份为 `backup-20261011-0830/telemetry.turso.db-tshm.corrupt`。
- [ ] **防复发加固（建议）**：服务启动时对 `short read on WAL frame` 增加一次性自愈——
      检测 WAL 为 0 字节时将 `-tshm` 移走并重试打开；否则同类损坏仍会让服务永久无法启动。
- [ ] **运维约束（建议）**：在部署 README 与上游文档中明确「禁止用 `sqlite3` / `node:sqlite` /
      Python `sqlite3` / GUI 工具直接打开 `*.turso.db`（含只读）」，数据检查一律走服务 API，备份按
      「停容器后整目录复制」执行。
- [ ] 跟踪上游 `@tursodatabase/database` 对 `multiprocess_wal` 崩溃一致性与恢复行为的改进
      （当前 0.8.2）；必要时向上游反馈最小复现。
- [ ] 事故负责人：确认上述两项加固的责任人与排期后关闭本事故。

预防重点：单文件嵌入式数据库的「共享内存索引」与「WAL」是两份独立状态，任何第三方工具（哪怕是只读
意图）都可能以不自洽的方式改动其中一份。凡涉及该数据目录的排查操作，必须使用本项目自带的驱动与
API，或在副本上操作。
