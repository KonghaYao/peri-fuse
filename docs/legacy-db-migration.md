# 旧 SQLite 数据迁移到 embedded Turso

入口：`scripts/migrate-legacy-db.sh`。它通过 `node:sqlite` **只读**访问旧库，使用当前 Turso 驱动写入新库，不重新安装 better-sqlite3。源码运行需要 Node.js **22.12.0 或更高版本**、Bash，以及已执行 `pnpm install` 的仓库；Docker 镜像使用 Bun 的兼容接口，并通过 `NODE_BINARY=bun` 运行迁移工具，无需在宿主机安装 Node 或 pnpm。脚本为旧版 Node 开启内置 SQLite 所需的实验标志，并兼容没有流式迭代接口的 Node 22.12。

## 执行步骤

先检查映射、数据量和缺失的数据库，检查阶段不创建目标文件：

```bash
bash scripts/migrate-legacy-db.sh --dry-run
```

默认读取 `${PERIFUSE_HOME:-$HOME/.peri-fuse}` 下的 `langfuse.db`、`telemetry.db` 和 `gateway.db`。**停止 Server、独立 Gateway，以及所有摄入、统计和维护写入进程**。`--offline` 是人工确认，不会自动停止进程。

```bash
pnpm svc:stop
bash scripts/migrate-legacy-db.sh --offline
```

输出在同一目录，旧文件保留：

| 旧文件 | 新文件 |
| --- | --- |
| `langfuse.db` | `langfuse.turso.db` |
| `telemetry.db` | `telemetry.turso.db` |
| `gateway.db` | `gateway.turso.db` |

如果要先迁移到一个新目录，或旧数据实际位于仓库的 `.langfuse` / Docker 的 `data`：

```bash
bash scripts/migrate-legacy-db.sh \
  --source-dir "$HOME/.peri-fuse" \
  --target-dir "$HOME/.peri-fuse-migrated" \
  --offline
```

自定义数据库文件可通过 `--metadata-source`、`--telemetry-source`、`--gateway-source` 指定；文件路径也支持 `file:` 前缀。`--role metadata|telemetry|gateway` 只迁移指定库。默认 `all` 会明确报告并跳过不存在的库，不创建空替代库；如果没有任何旧库则退出失败。请确认报告中的跳过项符合预期。

## Docker 部署

迁移发生在挂载的数据卷中，**不是在构建镜像时**。新镜像包含 `/app/scripts/migrate-legacy-db.sh`；旧镜像不包含该脚本，需要先构建或拉取包含本次变更的新镜像。不会在容器启动时自动迁移大库。

仓库默认 Compose 将宿主机 `./data` 挂载到 `/app/data`。使用新镜像执行一次性任务，继承同一个卷与密钥环境配置，但不启动 HTTP 服务：

```bash
# 先构建/拉取新镜像，保留旧镜像以便回滚
# 本地构建：先按 docker-compose.yml 注释启用 build，再执行：
docker compose build peri-fuse
# 发布镜像：改为 docker compose pull peri-fuse

docker compose stop peri-fuse
# 同时停止所有使用该数据卷的独立 Gateway 和其他写入进程
docker compose run --rm --no-deps --entrypoint bash peri-fuse \
  /app/scripts/migrate-legacy-db.sh --dry-run
docker compose run --rm --no-deps --entrypoint bash peri-fuse \
  /app/scripts/migrate-legacy-db.sh --offline

# 仅在迁移成功、确认使用新文件且保留原密钥之后启动
docker compose up -d peri-fuse
```

如果用 `docker run`，保持原挂载方式；下面 `peri-fuse:migration` 是你构建的新镜像标签，`peri-fuse-data` 必须替换成原服务实际使用的命名卷。不要新建空卷替代旧数据：

```bash
docker build -t peri-fuse:migration .
docker stop peri-fuse
docker run --rm --entrypoint bash -v peri-fuse-data:/app/data \
  peri-fuse:migration /app/scripts/migrate-legacy-db.sh --dry-run
docker run --rm --entrypoint bash -v peri-fuse-data:/app/data \
  peri-fuse:migration /app/scripts/migrate-legacy-db.sh --offline
```

使用目录挂载时，将 `-v peri-fuse-data:/app/data` 替换为 `-v /absolute/path/to/data:/app/data`。确保新服务与迁移容器对卷有相同的访问权限；输出文件权限为 `0600`。宿主机需要额外磁盘空间，迁移容器也需足够内存。不要执行 `docker compose down -v`，不要删除卷，也不要只拷贝旧主库而遗漏 WAL / 密钥。

正常中断退出后，用同样的命令追加 `--resume` 即可。异常强杀可能留下 `.legacy-turso-migration.lock`；新容器的 hostname/PID 命名空间不同，脚本会保守拒绝接管。此时必须先确认旧迁移容器及所有写入进程已经停止，再人工清理**仅这个锁文件**，重新运行 `--offline --resume`。不要删除 `.migrating` 数据库、WAL 或迁移状态。恢复时保持相同卷、源路径、目标路径和镜像版本。

默认新路径已经是 `/app/data/*.turso.db`。如果自己的 Compose / `docker run` 仍覆盖 `DATABASE_URL`、`LANGFUSE_SQLITE_DB_PATH`、`GATEWAY_DB_URL` 为旧文件，需要改成新路径。保留原 `SALT` / `GATEWAY_ENCRYPTION_KEY` 或卷内密钥文件；远端 `TURSO_*` 设置会使服务优先使用远端，迁移脚本不会上传本地数据。

## 大库与断点恢复

- 不使用全量 JSON 导出或 `.dump`，不将整个表读入内存。按 `rowid` 顺序流式读取；Node 22.12 使用索引定位、每次最多读取一行的兼容路径。
- 默认每个批次最多 200 行、约 8 MiB 数据，同时将绑定参数控制在 900 个以内。单行最多 64 MiB；超限会报错，不会丢弃或截断。可显式设置 `--batch-rows`、`--batch-mib` 和 `--max-row-mib`。
- 默认限制是应用批次数据量，不是进程 RSS 上限。原生驱动缓存、单行处理和索引构建还需要额外内存；大库请预留足够内存，不要同时启动服务。
- 每个批次将数据、行数、游标和内容摘要一起事务提交。复制阶段每约 32 MiB 做 WAL checkpoint，搜索重建分段 checkpoint。二级索引最后创建，减少导入期间的随机写入。
- 预估目标文件、WAL 和索引的额外磁盘空间；保留原库意味着需要额外容量。预估不是容量保证，数据分布、空闲页和索引大小会影响最终占用。
- 目标写入 `.<name>.turso.db.migrating`。全部数据库校验完成前不会发布到正式的新库路径，现有正式目标文件不会被覆盖。

中断后保持停服，使用**相同源文件、目标目录和角色**恢复，可调整批次大小：

```bash
bash scripts/migrate-legacy-db.sh --offline --resume
```

迁移到自定义目录时，恢复命令也必须包含原来的 `--source-dir` / `--target-dir`。Ctrl-C / SIGTERM 会在安全点退出；已提交批次可恢复。进程异常终止留下的锁，只有 `--resume` 确认同机原进程已不存在后才会清理。不同主机的锁或仍存活的进程不会被强行接管。

源主文件及 WAL 的身份、大小或修改时间发生变化时，拒绝续传，以防混合不同时间的数据。此时需重新停服并选择新的输出目录。未识别的目标库也不会被接管。初始化尚未提交就发生崩溃的目标可能无法续传，同样使用新的输出目录重试，不要删除原库。

## 保留与转换

- 保留原 `rowid`、业务主键、`projectId` / `project_id`、API-key 哈希、加密凭据、压缩 BLOB 及 codec/raw-size 信息。
- Gateway 表名从旧 PascalCase 映射为当前小写名称；字段按当前 schema 对齐，兼容 snake_case / camelCase。缺少可默认初始化的新字段使用当前默认值；缺失必填字段、未识别业务表或字段会失败，而不是静默丢数据。
- 元数据的旧 DATETIME 转换为当前 Drizzle 使用的毫秒整数；Gateway 的旧 DATETIME 转换为 ISO-8601 文本。没有时区的 SQLite 日期按 UTC 解释。
- 保留统计投影、摄入版本、搜索 revision/dirty/state 和搜索文本、命中位置。旧 FTS 虚拟表及其 shadow 表不复制，从保留的文本重建项目隔离的 Unicode trigram 索引；废弃的 `trace_counts` 和旧迁移日志也不复制。
- 如果旧库缺少搜索数据，创建空的新搜索结构，首次启动后由现有后台 backfill 重建。
- 源目录的 `.salt` / `.encryption-key` 原样复制到新目录，权限为 `0600`。已有但不同的目标密钥会被拒绝。环境变量中的 `SALT` / `GATEWAY_ENCRYPTION_KEY` 不会导出，请继续使用旧值；尤其不要让服务自动生成新的密钥替代旧值。

每个复制的表都按迁移后的字段类型进行逐行 SHA-256 摘要和行数校验，包含原 `rowid`；BLOB 不解压、不重新编码。目标完成 checkpoint 后，再通过独立的 Node SQLite 只读连接执行 `foreign_key_check` 和 `quick_check`，验证外键及文件结构。原生 Turso 驱动自身的外键检查结果不能作为这里唯一的校验依据。

校验结果记录在 `<name>.turso.db.migration.json`，不包含行内容或密钥原文。每个正式目标库包含当前 schema 的迁移日志，因此服务启动不会重新创建旧表。保留原 DB **及其 WAL**，直到确认迁移结果和服务行为符合预期；不要只备份主文件。

## 启动与回滚

迁移成功后，将 `PERIFUSE_HOME` 指向目标目录。删除旧 `.env` 中指向旧文件的本地路径覆盖，或者明确设置新路径：

```dotenv
PERIFUSE_HOME=/absolute/path/to/migrated-directory
DATABASE_URL=file:/absolute/path/to/migrated-directory/langfuse.turso.db
LANGFUSE_SQLITE_DB_PATH=/absolute/path/to/migrated-directory/telemetry.turso.db
GATEWAY_DB_URL=file:/absolute/path/to/migrated-directory/gateway.turso.db
```

同时清除 `TURSO_DATABASE_URL`、各角色 `TURSO_*_DATABASE_URL` 等远端设置，否则服务仍会优先使用远端连接。脚本本身忽略远端设置，**只迁移到本地 embedded 文件**。

再启动新版本服务并确认历史 traces、观测、统计、搜索和 Gateway 配置。若需回滚，停止新版本，用旧版本程序重新指向未修改的旧 DB/WAL 和原密钥；新版本产生的数据不会自动反向同步到旧库。
