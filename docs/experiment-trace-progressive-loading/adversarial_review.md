# 对抗验证：Trace 渐进加载与大响应日志

## 结论

**PARTIAL（无致命问题；中等风险 4 项，低风险 2 项）**。固定大 trace/session 的响应体积下降可复算，代码也确实把 observation IO 改为选中后请求；但“真实浏览器首屏已验证”“默认 API 完全兼容”“大响应均可靠留痕”均超出现有证据。最终置信度：**中高（70%）**；对 payload 优化为高，对产品完整性和发布门禁为中。

## 证伪结果

1. **浏览器请求集合：中等风险 / PARTIAL**
   HTTP 实验只证明 shell（678 B）+首个 summary（96,872 B）为 97,550 B。静态代码显示 `useInfiniteQuery` 首次只取一页、`fetchNextPage` 仅由按钮触发，且 `selectedId` 初值 `undefined`，不会取 trace/observation IO；这强力支持设计，但没有 waterfall，不能排除路由重挂载、React Query 配置或运行态回归。结论应称“首批两个 API 响应”，不能称浏览器首屏已实测。

2. **默认公共 API：中等风险 / PARTIAL**
   session 两个开关默认均为 true，默认嵌套数据测试通过；trace 默认仍返回完整 observations。可是 trace 无参数响应新增 `observationCount`（实测恰多 24 B），对宽松 JSON 客户端通常是兼容的，对严格 schema/快照不是逐字段兼容。未跑外部 SDK 契约矩阵，故只能声称默认数据保留，不能声称契约完全兼容。

3. **项目隔离：低风险 / PASS（测试缺口）**
   trace 用认证 `projectId` 查询；session 的 traces、metrics、scores、observations 全带 `project_id`；v2 observation 基础 WHERE 与 trace 子查询也带项目条件。selected detail 虽仅以 observation id 过滤，仍叠加认证项目条件，且 observation id 为主键。未见越权路径，但本次新增 progressive/session/detail 流程没有第二项目回归测试。

4. **流式日志：中等风险 / PARTIAL**
   `pipeThrough(TransformStream)` 保留背压并向上游传播取消，不 clone/buffer；计数是应用响应 body 的 chunk bytes，不含 header/HTTP framing，未来若压缩中间件次序变化也未定义为线上 wire bytes。warning 只在 `flush`（完整消费）写出：客户端中断/取消不会留下“大响应已部分传输”记录；`write` 抛错还可能使流失败。现有测试只覆盖完整大/小响应，未覆盖 cancel、分块和日志失败。

5. **分页树与时间线：中等风险 / PARTIAL**
   v2 按 `start_time DESC` 分页，而子节点常晚于父节点；首批子节点若父未加载，`buildTree` 会把它当根，后续加载时层级重排。时间线仅使用已加载页；session 初始全折叠时可打开空时间线。虽有 “Load more” 和已加载/总数，但时间线未标注局部数据，可能导致误判，应显示“部分数据”或禁用/按需补全。

6. **选中详情：低风险 / PASS**
   ID 使用结构化等值 filter、limit=1，并受 project scope 约束；字段包含 io/metadata，`expandMetadata=*` 被服务端解析为 all，客户端再尝试 JSON 解码，现场单条详情 952,386 B 也证明该路径生效。缺少专门的 ID 精确过滤、跨项目及长 metadata 端到端 UI 测试。

7. **质量门禁：PARTIAL**
   相关 34 测试、server typecheck、Web build、内部 `tsc --skipLibCheck` 与定向 lint 通过；全 server 194 项中有 1 项 prompts 排序/依赖失败，常规 Web/root typecheck 被第三方声明阻塞，全仓 lint 被既有生成文件问题阻塞。因此可证明改动局部健康，不能声称仓库级 quick verification 全绿。

## 最终判定

核心优化可交付为实验性改进，且没有发现 projectId 泄漏或重新自动下载全部分页的致命缺陷。发布结论须保留上述限制；优先补 Playwright network 断言、跨项目详情测试、分页不完整提示，以及 logger cancel/异常测试。

## 审查后处置

主流程已隔离日志 sink 抛出的异常，并增加“日志失败不影响 200 响应”的回归测试；断连不记录、局部时间线提示及其余证据缺口仍保留。
