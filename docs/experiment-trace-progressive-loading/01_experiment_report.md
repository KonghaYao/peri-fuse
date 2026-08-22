# 实验 1：Trace 渐进加载基线与最小复现

## 状态

**DONE_WITH_CONCERNS**

实验要求的 4 组请求均完成 2 次测量，status、响应 bytes、TTFB、总耗时与
`X-Cache` 均已记录。主要关注点是实验发生在有并行修改的 dirty worktree 上，且本地
认证只能通过 Web UI 的官方项目激活流程取得，因此认证数据库产生了 `web-ui` key
变更；详见“异常与发现”。未修改产品代码，未记录密钥、Authorization header 或响应正文。

## 基本信息

- **日期**：2026-08-22（Asia/Shanghai）
- **研究问题**：在默认 public API 响应保持兼容的前提下，字段组与轻量 observation
  分页是否足以显著降低 trace 首屏传输量和等待时间？
- **本轮假设**：默认 trace 会因嵌入全部 observation IO 形成百 MB 级响应；
  `fields=core`、不含 observations 的组合字段以及 v2 observations 轻量 50 条分页会把
  首批响应降到可用于渐进渲染的量级。
- **目标 trace**：`01a005c06a5477b3a720fbcd5615f05e`
- **目标 projectId**：`e44b3574-143b-46dd-aa68-5c489b30b1f6`
- **目标 trace observations 数**：2,032（按 `trace_id + project_id` 只读计数）

## 环境

| 项目 | 值 |
| --- | --- |
| 服务 | `http://localhost:23432` |
| 服务进程 | Node PID 94637，实验时已监听 `*:23432` |
| Git HEAD | `c08975e124cf658cf4cac9f59e30458fba6c8032` |
| 工作区 | dirty；实验相关 server/web 文件正在被并行修改 |
| Node.js | v22.20.0 |
| pnpm | 10.14.0 |
| curl | 8.7.1 |
| telemetry.db | 5,739,769,856 bytes（约 5.35 GiB） |
| 数据库路径 | `~/.peri-fuse/telemetry.db` |
| 响应缓存 | trace/v2 observations 路由 TTL 2,000 ms；进程总 body 上限 32 MiB |

实验时 `git status --short` 显示的相关在途文件包括 trace/session/observations 路由、
Web trace/session 页面、query hooks，以及 large-response logger。因共享工作区存在并行修改，
本报告描述的是“实验时间点正在运行的 localhost 服务”，不是干净 HEAD 的历史基线。

## 实验方法

1. 检查 `localhost:23432/api/public/health`；初次检查时服务未运行，尝试启动开发服务时
   发现端口已被另一个现存 Node 进程占用，之后复用该进程。
2. 确认目标 trace 的 `project_id`，通过本地 Web UI 的官方
   `POST /api/manage/projects/:id/activate` 流程生成测量用 `web-ui` key。
3. key 仅保存在测量 shell 进程内存中；所有响应正文直接写入 `/dev/null`。
4. 每组请求开始前等待 3 秒，使 2 秒应用响应缓存过期；随后连续请求两次，以同时观察
   首次计算与立即重复请求。
5. 使用 curl `size_download`、`time_starttransfer`、`time_total` 和响应头 `X-Cache`
   采集指标。没有输出请求 header、密钥或 JSON 正文。
6. 请求顺序固定为默认 trace、core trace、组合字段 trace、v2 observations 轻量页。

### 请求组

| 标签 | 请求（省略 host） | 目的 |
| --- | --- | --- |
| `trace_default` | `GET /api/public/traces/:traceId` | SDK 兼容默认完整响应 |
| `trace_core` | `GET /api/public/traces/:traceId?fields=core` | 最小 trace 核心字段 |
| `trace_core_io_scores_metrics` | `GET /api/public/traces/:traceId?fields=core,io,scores,metrics` | 保留 trace IO、scores、metrics，但不嵌入 observations |
| `observations_v2_core_50` | `GET /api/public/v2/observations?traceId=:traceId&limit=50&fields=core` | 首批 50 条轻量 observation |

## 原始数据

时间单位为秒；`bytes` 为 curl 实际下载的响应 body 大小；`cache` 为 `X-Cache`。

| label | run | status | bytes | TTFB | total | cache |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| trace_default | 1 | 200 | 191,169,311 | 1.678733 | 1.724379 | SKIP |
| trace_default | 2 | 200 | 191,169,311 | 1.502084 | 1.547837 | SKIP |
| trace_core | 1 | 200 | 649 | 0.006015 | 0.006050 | MISS |
| trace_core | 2 | 200 | 649 | 0.002039 | 0.002066 | HIT |
| trace_core_io_scores_metrics | 1 | 200 | 684,862 | 0.086942 | 0.087137 | MISS |
| trace_core_io_scores_metrics | 2 | 200 | 684,862 | 0.002081 | 0.002298 | HIT |
| observations_v2_core_50 | 1 | 200 | 18,376 | 0.143227 | 0.143297 | MISS |
| observations_v2_core_50 | 2 | 200 | 18,376 | 0.001259 | 0.001297 | HIT |

### 原始 TSV

```text
label	run	status	bytes	ttfb_s	total_s	x_cache
trace_default	1	200	191169311	1.678733	1.724379	SKIP
trace_default	2	200	191169311	1.502084	1.547837	SKIP
trace_core	1	200	649	0.006015	0.006050	MISS
trace_core	2	200	649	0.002039	0.002066	HIT
trace_core_io_scores_metrics	1	200	684862	0.086942	0.087137	MISS
trace_core_io_scores_metrics	2	200	684862	0.002081	0.002298	HIT
observations_v2_core_50	1	200	18376	0.143227	0.143297	MISS
observations_v2_core_50	2	200	18376	0.001259	0.001297	HIT
```

## 分析结果

### 描述性统计

每组只有 2 个样本，因此中位数等于均值。标准差使用总体标准差，仅用于描述本轮波动，
不应解释为稳定的性能分布。

| 请求组 | bytes | TTFB 均值/中位数 | TTFB σ | total 均值/中位数 | total σ |
| --- | ---: | ---: | ---: | ---: | ---: |
| trace_default | 191,169,311 | 1.590409 | 0.088325 | 1.636108 | 0.088271 |
| trace_core | 649 | 0.004027 | 0.001988 | 0.004058 | 0.001992 |
| trace_core_io_scores_metrics | 684,862 | 0.044512 | 0.042431 | 0.044718 | 0.042420 |
| observations_v2_core_50 | 18,376 | 0.072243 | 0.070984 | 0.072297 | 0.071000 |

### 传输量对比

| 请求组 | 相对默认 trace 减少 | 默认响应是其多少倍 |
| --- | ---: | ---: |
| trace_core | 99.99966% | 294,560x |
| trace_core_io_scores_metrics | 99.64175% | 279.14x |
| observations_v2_core_50 | 99.99039% | 10,403.21x |

默认响应为 191.17 MB（十进制），已经明显超过“几 MB”问题描述。组合字段即使保留 trace
自身 IO、scores 和 metrics，也只有约 685 kB；轻量 observation 首批 50 条约 18.4 kB。
这说明 observation IO/完整 observations 嵌入是该 trace 响应膨胀的主导因素。

### 首次计算与缓存

- 默认 trace 两次均为 `SKIP`。其 191 MB body 超过响应缓存 32 MiB 上限，因此不会被缓存；
  重复查看仍会重新查询、整形和传输完整响应。
- 其余三组第一次为 `MISS`、立即重复为 `HIT`，符合路由 2 秒 TTL。
- 冷请求（run 1）TTFB 分别为：默认 1.679 s、core 6.0 ms、组合字段 86.9 ms、
  v2 轻量 50 条 143.2 ms。
- v2 轻量页 bytes 很小，但冷 TTFB 高于组合字段。本轮没有做 query plan 或独立随机化，
  因而只能判断网络 payload 已足够小，不能据此断言 v2 查询本身已经最优。

## 结论

本轮数据支持假设：对该 2,032-observation trace，默认兼容响应达到 191,169,311 bytes，
而适合首屏的 `fields=core` 仅 649 bytes，v2 observation 核心字段 50 条仅 18,376 bytes。
后端现有可选字段与轻量分页能力在协议层已经能把首批传输量降低四到五个数量级。

因此前端渐进加载应以“trace core 先渲染 → observation core 分页 → 选中单条后再取 IO”为
数据流边界，并明确避免后台自动遍历全部分页或为每一条 observation 预取 IO。默认
`GET /api/public/traces/:id` 必须继续保留现有完整响应，以满足 SDK 兼容要求。

## 异常与发现

1. **工作区非干净，且实现正在并行变化。** 本实验不是相对 HEAD 的严格历史基线；它是
   当前 localhost 服务与当前 5.35 GiB 数据的可复现现场测量。验证 agent 应核对服务实际
   加载的源码版本，并在实现稳定后复测。
2. **认证流程产生数据库扰动。** `.env` 不含 API key，未认证 trace 请求返回 401。
   为避免扫描或打印用户凭据，实验使用官方本地 `activate` 流程。UI 项目选择、一次失败的
   测量脚本和成功脚本共触发 3 次 activate；每次会创建 `note=web-ui` 的 key，并可能按实现
   规则裁剪超出 5 枚的旧 web-ui key。没有手工删除或清理 key。
3. **首次脚本失败未产生性能样本。** 脚本把 zsh 特殊变量 `path` 当普通变量，覆盖命令
   搜索路径，在第一个 `sleep` 前退出；表中仅包含修正变量名后的成功运行。
4. **缓存条件不对称。** 默认响应因超过 32 MiB 被 SKIP，其他响应 run 2 命中缓存；平均值
   混合了冷/热样本。实现后对比应优先使用相同 cache 状态，或分别报告冷/热结果。
5. **样本量与顺序效应。** 每组仅 n=2，且顺序固定；SQLite page cache、OS cache、Node GC
   和并行开发服务热重载均未隔离。体积结论可信度高，细粒度耗时结论可信度较低。
6. **只测了 trace 方案所列四组。** 本轮任务没有要求 session endpoint 的原始请求，因此
   未额外发起可能达到百 MB 的 session 请求。

## 可复现步骤

以下命令展示测量结构。它会调用本地项目激活端点创建 `web-ui` key；不要在共享或生产
环境执行。命令不会打印 key 或响应正文。

```bash
project_id='e44b3574-143b-46dd-aa68-5c489b30b1f6'
trace_id='01a005c06a5477b3a720fbcd5615f05e'
auth_json=$(curl -fsS -X POST \
  "http://localhost:23432/api/manage/projects/${project_id}/activate")
public_key=$(printf '%s' "$auth_json" | jq -er '.publicKey')
secret_key=$(printf '%s' "$auth_json" | jq -er '.secretKey')
auth_basic=$(printf '%s:%s' "$public_key" "$secret_key" | base64 | tr -d '\n')
unset auth_json public_key secret_key

curl -sS -o /dev/null \
  -H "Authorization: Basic ${auth_basic}" \
  -w 'status=%{http_code} bytes=%{size_download} ttfb=%{time_starttransfer} total=%{time_total} cache=%header{x-cache}\n' \
  "http://localhost:23432/api/public/traces/${trace_id}?fields=core"

unset auth_basic
```

完整复测时，对“请求组”表中的四个 URL 各等待至少 3 秒后连续执行两次。

## 下一步建议

1. 验证本报告的数据完整性、cache 状态解释和 dirty-worktree 风险。
2. 实现稳定后以相同 trace、projectId、数据库和请求顺序做第 2 轮复测，并将冷/热指标分开。
3. 第 2 轮额外检查浏览器实际请求瀑布，确认首屏没有自动下载默认完整 trace、遍历全部
   observation 分页或预取全部 IO。
4. 对默认 191 MB 响应检查大响应 warning 是否仅记录 method、path、status、bytes、
   durationMs、projectId，且不记录 query 中的敏感值、Authorization 或正文。
