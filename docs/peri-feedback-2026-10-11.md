# Peri 平台反馈：后台子任务静默卡死与可观测性缺失

- **日期**：2026-10-11
- **场景**：peri-fuse（langfuse-lite）仓库，多工作流并行（2 个 recon/设计 + 2 个实施 + 1 个盘点）
- **结论**：一次模型侧传输故障导致 2 个实施子任务长期静默；平台缺少任务状态查询、取消与交付保障能力，协调者最终只能人工盘点 + 书面交接收场。

## 1. 时间线

1. recon、设计两个子任务正常完成（各约 14–15 分钟）。
2. 启动 2 个实施子任务（general-purpose，sonnet 档）。
3. 其中一个（sqlite-impl）报 LLM 传输失败：`retry exhausted after 6 attempts; http2 error; stream error received: unexpected internal error encountered`（DeepSeek API），按平台指引 resume 成功。
4. 此后两个实施任务均长期静默：多轮 bounded wait 仅报 `pending: 2`，无任何进度信息。
5. 协调者向两个任务发送"排队式进度查询"：返回 `action: send / status: queued`，此后无任何反馈（不保证被消费）。
6. 用户从界面观察到模型超时；协调者确认平台**无状态查询、无取消**手段。
7. 期间第 3 个任务（只读盘点，explorer）成功完成——同期小模型/短任务正常，说明故障具有间歇性。
8. 最终以只读盘点 + 人工交接收场（见 `docs/handover-bun-sqlite-2026-10-11.md`）。

## 2. 问题清单（按影响排序）

1. **任务不可观测**：没有任务状态/进度/最后活动时间查询工具。`AgentResult` 被明确标注为占位符（DO NOT CALL），协调者无法区分【运行中 / 卡死 / 已完成但通知丢失】三种状态。
2. **模型传输故障缺乏降级**：http2 stream error 重试 6 次耗尽即失败/静默；无熔断后的自动降级（fallback 模型/供应商），长任务断流后也没有"超时判定"通知送达协调者。
3. **无取消能力**：协调者工具集无任务取消接口（文档所称 "host's cancellation interface" 未暴露给模型）。用户要求"中断所有任务"时，协调者无法执行。
4. **排队消息语义不可靠**：`status: queued` 不承诺被消费、无投递回执、无法借此确认任务是否还存活；对卡死任务完全无效。
5. **结果交付不可靠**：bounded wait 提示"结果由 scope owner 在 resume 时协调交付"，但协调者没有主动触发交付的机制（对 active 线程 send 只排队；resume 不可用）。
6. **task_id / thread_id 易混**：启动回执同时给出两个格式相近的 ID（`bg-` 前缀 task_id 与纯 UUID thread_id），协调者误用 task_id 作为 resume_thread_id，触发 `thread not found`。
7. **失败现场无自动快照**：卡死的实施任务实际已在磁盘留下约 2500 行未提交改动（17 个文件修改 + 11 个新文件），但没有任何"任务中断时的进度快照"机制；交接完全依赖人工只读盘点（本次靠 explorer 逐文件比对才完成）。

## 3. 协调者侧的直接损失

- 2 个子任务的计算与等待全部浪费（未产出任何验收报告）；
- 用户等待超过 30 分钟后被迫手动干预；
- 交接需要额外一个只读盘点任务兜底（所幸它成功了）。

## 4. 建议（按优先级）

1. **暴露只读任务状态查询**：状态机、最后活动时间、最近工具调用、token/步骤进度。
2. **心跳与疑似卡死检测**：N 分钟无模型增量输出 → 主动通知协调者（标注 suspect / stalled）。
3. **协调者可用的取消接口**（单个 / 全部），并返回确认。
4. **模型故障降级策略**：可配置 fallback 模型；失败分类明确（transport vs 逻辑）；重试中周期性回报最后进度。
5. **`send` 投递回执**（已读 / 已消费），或提供"强制 resume / 拉取交付"能力。
6. **任务终止/中断时自动生成进度快照**（已完成/未完成步骤、工作区改动摘要）写入任务元数据，供接续者直接消费。
7. **强化 task_id / thread_id 区分**（回执措辞、文档、工具出入参提示）。

## 5. 原始证据

- 失败原文：`LLM model error: model retry exhausted after 6 attempts; last failure: transport: error sending request for url (https://api.deepseek.com/anthropic/v1/messages); caused by: http2 error; stream error received: unexpected internal error encountered`
- 任务 ID：
  - bun-migration：task `bg-01a12902-3bed-7232-8e70-17f2450dc6f1` / thread `01a12902-3bed-7232-8e70-17ed8254387e`
  - sqlite-impl：task `bg-01a12921-4a70-7631-803e-253c5bbca2d4`（resume 后）/ thread `01a12902-d037-7a73-bb0b-cb3914a8ce09`
- bounded wait：两轮 `pending: 2, waited_ms: 120002`
- 协调者发送结果：两个任务均 `action: send, status: queued`，无后续反馈
- 磁盘证据：工作区含完整实施改动（`Dockerfile`、根/各包 `package.json`、`packages/shared/src/db/**` 共 17 修改 + 11 新增），证明任务在静默前已实际执行数十步工具调用
