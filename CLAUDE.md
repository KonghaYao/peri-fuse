# CLAUDE.md

> AI Agent 快速指引见 [AGENTS.md](./AGENTS.md)；各包细节见 `packages/*/AGENTS.md`。

## 核心工程原则

1. **架构与领域优先**：计划阶段应以理想架构为目标，明确业务目标、领域边界、模块职责、依赖方向和数据流，形成符合领域规律、面向长期维护且可持续演进的设计后再进入编码；不得以短期实现便利牺牲整体设计。
2. **追求优雅的代码模块**：模块应高内聚、低耦合，通过精简且稳定的接口封装内部复杂度，使职责、命名、依赖和扩展方式清晰自然；代码按单一职责拆分，单个文件不得超过 500 行，接近上限时应优先重构模块边界。
3. **保持边界与数据流清晰**：协议模型、领域模型、持久化模型和视图模型不得相互泄漏；数据必须在边界处完成校验和独立转换，避免跨层共享可变状态。
4. **轻量与零外部依赖**：本项目核心价值在于纯 SQLite 后端、零外部服务依赖（无 ClickHouse/Redis/S3/BullMQ）；新增功能不得引入需要独立部署的外部基础设施。
5. **保障完整前端体验**：前端应控制渲染成本、异步状态和并发请求，保持清晰的 UI 结构；用户流程必须覆盖加载、空状态、错误、重试和反馈。
6. **复用稳定的业务语义**：优先复用 `@peri-fuse/shared` 已有模块和能力，但不要仅因代码外形相似而过早抽象；确需重复时，必须注释说明其独立演进或暂不抽象的原因。
7. **为未来维护者保留上下文**：非显然的设计决策、兼容约束、已知缺陷和临时方案，必须记录原因、影响范围和移除条件；禁止留下缺少上下文的 `TODO`。
8. **确保变更可验证、可观测、可回滚**：每项改动都应行为可测试、运行状态可观测、故障可定位，并兼顾向后兼容和回滚路径。

> **变更速查**：提交前运行 `pnpm run typecheck && pnpm run lint && pnpm run test`；修改前端后额外运行 `pnpm run build`（确保 web 生产构建通过）；修改 Prisma schema 后运行 `pnpm run db:generate` 和 `pnpm run db:push`。

## 项目与架构地图

Langfuse Lite（包名 `peri-fuse`）是 Langfuse 的轻量级自包含版本，专为本地开发、小团队和边缘部署设计。纯 SQLite 后端，零外部依赖。

- 主要能力：LLM 可观测性（traces/spans/generations/scores）、OpenTelemetry (OTLP) 数据接入、兼容 Langfuse SDK 的 REST API、轻量 Web 仪表盘、LLM 代理网关（PeriGateway）。
- pnpm monorepo + Turbo 构建编排，Node.js >= 22。
- `packages/` 包含 6 个内部包：`shared`、`server`、`web`、`gateway`、`cli`、`langfuse-mcp`；跨包能力应通过包导出的稳定接口复用，不得依赖包内实现细节。

### 后端地图（packages/server）

- `src/index.ts`：服务入口，强制 lite 模式并启动 Hono HTTP 服务。
- `src/env.ts`：环境引导，设置 `LANGFUSE_MODE=lite`、SQLite 路径默认值。**必须最先导入**。
- `src/app.ts`：Hono 应用装配层（路由注册、CORS、全局错误处理、SPA 静态资源托管）。
- `src/auth.ts`：HTTP Basic 认证中间件（publicKey:secretKey）。
- `src/routes/`：API 路由（ingestion、otel、traces、observations、scores、sessions、dashboard、health）。
- `src/schemas/`：请求/响应 Zod schema。
- `src/shaping/`：数据整形层（将存储数据转换为 API 响应格式）。
- `src/__tests__/`：后端集成测试（Vitest）。

### 网关地图（packages/gateway）

PeriGateway 是统一的 LLM 代理网关，提供多 Provider 路由、限流、预算控制和请求可观测性。

- `src/index.ts`：服务入口（默认端口 4100），启动后台服务（SpendFlusher、BudgetReset、CooldownRecovery）。
- `src/env.ts`：环境配置解析，数据目录默认 `~/.peri-fuse`。**必须最先导入**。
- `src/app.ts`：Hono 应用装配层，定义 `GatewayEnv` 类型（Context Variables）。
- `src/middleware/auth.ts`：统一鉴权中间件 `unifiedAuth`（Bearer + Basic），验证 project-scoped API key。
- `src/db.ts`：Drizzle ORM 连接管理 + 增量迁移逻辑。
- `src/db/schema.ts`：Drizzle schema 定义（9 张表，全部含 `projectId` 列）。
- `src/router/`：模型解析（model-resolver）、路由策略（weighted-shuffle / priority / lowest-latency）、cooldown 恢复。
- `src/provider/`：Provider 适配器（openai / anthropic），统一请求/响应协议。
- `src/routes/proxy/`：数据平面路由（chat completions、messages、models）。
- `src/routes/admin/`：控制平面路由（providers、credentials、models、keys、budgets、usage、logs、audit）。
- `src/hooks/`：Hook 系统（parallel-limiter、rate-limiter、budget-limiter、peri-fuse-logger）。
- `src/spend/`：花费计算、同步事务记账（保留 SpendFlusher 接口）、预算重置。
- `drizzle/`：SQL 增量迁移文件（含 DailySpend 项目隔离索引迁移）。
- `test/integration.test.ts`：集成测试（31 个用例，覆盖多项目隔离）。

### MCP 地图（packages/langfuse-mcp）

- 主 server 的 `/mcp` 端点共用服务端口，公开只读 skill 资源，不要求认证或请求 headers，不启动额外进程。
- MCP 包封装 MCPP 协议与 skill 资源注册；数据 API 继续由 server 的项目级 API key 保护。
- `skills/langfuse/` 是可分发的文档和分析脚本，通过 `skill://langfuse/…` 读取；不注入项目凭据或遥测数据。
- 分析脚本由客户端运行，使用客户端自己的 Langfuse 环境变量访问现有 REST API。
- MCP 构建必须先于 server；CLI 分发包必须同时包含 skill 文件。

### SPA 与未知路径行为

- 已知 web 页面仅在请求为 `GET`/`HEAD` 且显式接受 `text/html` 时回退到 `index.html`。
- 已存在的静态文件按原文件响应；未知页面/API 路径、缺失静态资源和 `/.well-known/*` 均返回 JSON 404。
- MCP 不提供 OAuth discovery、Basic 或 Bearer 鉴权；资源端点支持 MCP `2026-07-28` 与无状态 `2025-11-25` 客户端。

### CLI 地图（packages/cli）

- 包名 `peri-fuse`，提供 `peri-fuse` 命令行工具，管理后台服务的启停、状态和日志。
- 使用 Commander.js，esbuild 单文件打包。

### 共享层地图（packages/shared）

- `src/db.ts`：Prisma 客户端实例。
- `src/env.ts`：全局环境变量 schema 与解析。
- `src/domain/`：领域模型与业务规则。
- `src/server/adapters/`：存储适配器（SQLite telemetry、内存缓存、内存队列、本地存储）。
- `src/server/auth/`：API Key 验证、权限类型。
- `src/server/ingestion/`：事件摄入管线（批处理、模型匹配、采样）。
- `src/server/otel/`：OTLP 协议解析与转换。
- `src/server/repositories/`：数据访问层（含 `lite-queries.ts` 轻量查询）。
- `src/server/services/`：业务服务（Dashboard、TableView 等）。
- `prisma/schema.sqlite.prisma`：Prisma schema 真相来源。
- `prisma/migrations/`：迁移历史。

### 前端地图（packages/web）

- `src/main.tsx`：应用入口（Solid Query + `@solidjs/router`）。
- `src/App.tsx`：路由定义（lazy routes + `RequireProject` 守卫）。
- `src/shell/`：应用壳（侧栏、布局；消费 `@peri/ui`）。
- `src/pages/`：页面组件（Phase 0 多为占位页）。
- `src/shared/lib/api.ts`：类型化 REST 客户端（调用 `/api/public/*`）。
- `src/shared/store/`：项目/主题/刷新间隔等 localStorage 状态。
- UI：`@peri/ui`（git submodule `vendor/peri-studio`）；Spectra token 桥接见 `peri-ui-bridge.css`。
- 路径别名：`@` → `packages/web/src`。

## 开发工作流

### 计划阶段

进入编码前必须：

1. 确认需求、领域术语、模块边界和数据流。
2. 查找已有实现和公共接口，优先深化现有模块，不并行创建第二套能力。
3. 确认变更是否影响 Langfuse SDK 兼容性（`/api/public/*` 接口须保持向后兼容）。
4. 定义验证方式（测试、typecheck、lint）。

### 常用命令

```bash
pnpm run dev                  # 同时启动后端（tsx watch）和前端（Vite）
pnpm run dev:server           # 仅后端开发（port 23432）
pnpm run dev:web              # 仅前端开发（Vite port 5173，代理 /api → 23432）
pnpm run build                # 全量构建（shared → gateway → server → cli → web）
pnpm run typecheck            # 全包 TypeScript 类型检查
pnpm run lint                 # Biome lint + format 检查
pnpm run lint:fix             # Biome 自动修复
pnpm run test                 # 全包 Vitest 测试
pnpm run db:generate          # Prisma generate（schema → client）
pnpm run db:push              # Prisma db push（schema → SQLite，开发用）

# Gateway 单独操作
pnpm --filter @peri/gateway run dev        # Gateway 开发模式（port 4100）
pnpm --filter @peri/gateway run test       # Gateway 集成测试
pnpm --filter @peri/gateway run typecheck  # Gateway 类型检查

# CLI 服务管理
pnpm run svc:start            # 启动后台服务
pnpm run svc:stop             # 停止后台服务
pnpm run svc:status           # 查看服务状态
pnpm run svc:logs             # 查看服务日志
```

### 按变更类型验证

- 后端改动：运行 `pnpm --filter @peri-fuse/server run test`，完成后运行 `pnpm run typecheck && pnpm run lint`。
- 共享层改动：运行 `pnpm --filter @peri-fuse/shared run test`，再运行依赖它的包的测试。
- 前端改动：运行 `pnpm --filter @peri-fuse/web run build`（生产构建不可省略，因为后端从 `packages/web/dist/` 挂载静态资源）。
- Gateway 改动：运行 `pnpm --filter @peri/gateway run test`（31 个集成测试），再运行 `pnpm --filter @peri/gateway run typecheck`。
- 数据库改动：修改 `packages/shared/prisma/schema.sqlite.prisma` → `pnpm run db:generate` → `pnpm run db:push` → 运行相关测试。
- 全量检查：`pnpm run typecheck && pnpm run lint && pnpm run test`。

## 架构边界与模块契约

### 依赖方向

`server → shared`，`gateway`（独立，通过共享 DB 与 server 协同），`web`（独立，通过 HTTP API 与 server 通信），`cli`（独立，管理服务进程）。

- server 只负责协议接入（Hono 路由）、认证、参数校验和响应映射。
- shared 承载领域逻辑、数据访问、摄入管线和 OTLP 处理。
- gateway 是独立的 LLM 代理网关，通过读取 server 的共享 DB（api_keys 表）完成鉴权，自身数据存储在独立的 gateway.db。
- web 是纯前端 SPA，通过 `/api/public/*` REST API 与 server 交互，不直接依赖 shared。
- 禁止 server 反向依赖 web，禁止 web 直接导入 shared 内部实现。

### API 边界（Server）

- 所有公开 API 挂载在 `/api/public/*`，兼容 Langfuse SDK 协议。
- OTLP 入口：`/api/public/otel/v1/traces`（protobuf + JSON）。
- 摄入入口：`/api/public/ingestion`（批量事件）。
- 认证方式：HTTP Basic（`publicKey:secretKey`），由 `authMiddleware` 统一处理。
- 响应格式遵循 Langfuse API 约定（分页使用 `meta: { page, limit, totalItems, totalPages }`）。
- 新增接口必须保持与 Langfuse SDK 的向后兼容性。

### Gateway 统一鉴权与项目隔离（核心规范）

**所有 Gateway 路由（proxy + admin）统一使用 project-scoped API key 鉴权，无全局 admin key。**

鉴权格式：
- `Authorization: Bearer <secretKey>`（proxy 客户端常用）
- `Authorization: Basic <base64(publicKey:secretKey)>`（server 兼容格式）

隔离规则：
- Gateway 所有资源（Provider、Credential、ModelDeployment、ApiKey、Budget、SpendLog、DailySpend、ErrorLog、AuditLog）全部按 `projectId` 隔离。
- 鉴权中间件从 server 共享 DB（`api_keys` 表）验证 key，解析出 `projectId` 和 `orgId`，注入 Hono Context Variables。
- 仅接受 `scope = 'PROJECT'` 的 key；`ORGANIZATION` 级别 key 返回 403。
- 所有 admin CRUD 查询必须带 `where(eq(table.projectId, projectId))` 过滤。
- Provider 和 Credential 的唯一约束为联合索引 `(projectId, name)`，不同项目允许同名资源。

新增 Gateway 资源表或路由时必须：
1. 表定义包含 `projectId: text("projectId").notNull()` + 索引。
2. 路由处理函数从 `c.get("projectId")` 获取项目 ID。
3. 所有查询/写入带 projectId 过滤/赋值。
4. 在 `test/integration.test.ts` 中补充跨项目隔离测试。

### 前端边界与体验

- 请求统一通过 `src/lib/api.ts` 的 `apiFetch<T>()`；已处理 auth header、JSON 解析和错误标准化。
- 数据获取使用 TanStack Solid Query（`useQuery`），遵循现有 staleTime 和 retry 配置。
- 基础组件优先从 `@peri/ui` barrel 引入（禁止 deep import）。
- 通用图标使用 `lucide-solid`。
- 样式使用 Tailwind CSS 4（`@tailwindcss/postcss`），工具类优先。
- 页面流程必须覆盖 loading（Skeleton）、empty、error 和 retry 状态。
- 开发时 Vite 代理 `/api` 到 `http://localhost:23432`（dev 端口）；生产时 server 直接托管 `web/dist`（port 23332）。

### 存储层

- 三 SQLite 数据库架构：
  - `langfuse.db`（Prisma）：认证、项目、组织、API Key 等元数据。Server 和 Gateway 共享读取。
  - `telemetry.db`（better-sqlite3）：traces、observations、scores 等遥测数据。
  - `gateway.db`（Drizzle ORM + better-sqlite3）：Gateway 自有数据（Provider、ModelDeployment、ApiKey config、Budget、日志）。
- 存储适配器通过 `packages/shared/src/server/adapters/factory.ts` 按 `LANGFUSE_MODE` 选择。
- Lite 模式使用 `sqlite-telemetry-adapter`、`in-memory-cache-adapter`、`in-memory-queue-adapter`、`local-storage-adapter`。
- 不得在 lite 路径中引入对 Redis/S3/ClickHouse/BullMQ 的运行时依赖。

## 数据库与迁移

### Server / Shared（Prisma）

- Prisma schema 真相来源：`packages/shared/prisma/schema.sqlite.prisma`。
- 标准流程：修改 schema → `pnpm run db:generate` → `pnpm run db:push`（开发）→ 运行相关测试。
- 遥测数据库（telemetry.db）的表结构由 `sqlite-telemetry-adapter.ts` 中的 DDL 管理。

### Gateway（Drizzle ORM）

- Schema 定义：`packages/gateway/src/db/schema.ts`。
- 迁移文件：`packages/gateway/drizzle/*.sql`（手动编写，幂等执行）。
- 迁移逻辑：`packages/gateway/src/db.ts` 中的 `ensureSchema()` 在启动时检测并执行未应用的迁移。
- 迁移设计必须考虑已有数据兼容性和幂等性（使用 `PRAGMA table_info` 检测列是否存在）。
- 新增表/列时：编写增量 SQL 迁移文件 → 更新 `ensureSchema()` 检测逻辑 → 更新 schema.ts 定义。

## 质量、测试与长期维护

### 测试

- 后端测试位于 `packages/server/src/__tests__/`，共享层测试与源码同目录（`*.test.ts`）。
- Gateway 测试位于 `packages/gateway/test/integration.test.ts`（Vitest，31 个用例）。
- 测试框架为 Vitest；后端集成测试使用 `packages/server/src/__tests__/global-setup.ts` 初始化临时数据库。
- Gateway 测试使用 mock LLM server + 临时 SQLite DB，覆盖：鉴权（Bearer/Basic/scope 拒绝）、代理（流式/非流式/Anthropic）、多项目隔离、限流、预算、完整生命周期。
- 前端当前无测试；如新增，放在 `packages/web/src/__tests__/`。
- 测试应覆盖摄入往返（ingestion roundtrip）、OTLP 解析、认证和查询过滤等关键路径。

### 代码风格

- Biome 统一 lint + format：2 空格缩进、双引号、分号、100 字符行宽。
- TypeScript 业务代码避免 `as any`；确因第三方类型缺陷需要规避时，使用最小范围的类型收窄。
- Zod 使用 v4（`zod` 包，非 `zod/v4` 子路径）。
- `catch` 必须保留诊断上下文，不得吞错；对外错误不得泄露内部实现。
- 公共函数和导出类型应有清晰文档注释，解释设计原因和边界条件。

### 命名与 Git

- 文件使用 kebab-case，React 组件使用 PascalCase，函数使用 camelCase，常量使用 UPPER_SNAKE_CASE。
- 提交信息使用 Angular 风格：`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:`。
- 未经明确要求不得创建 commit；代码改动提交前必须通过 typecheck + lint + test。

### 质量红线

- 不得新增 typecheck、lint 或测试错误。
- 每条变更都应能追溯到需求或缺陷修复，禁止顺手重构无关代码。
- 自动修复工具（`lint:fix`）只能用于已审查范围，不得为了通过检查而无边界改写无关文件。

## 环境变量

环境变量以 `.env.example` 为参考，运行时由各包的 env 模块解析。

### 全局 / Server

- `LITE_SERVER_PORT`：Server 端口（生产默认 23332；开发统一用 23432，root `dev`/`dev:server` 脚本与 `vite.config.ts` 代理已按此约定，勿混用）。
- `LITE_LARGE_RESPONSE_THRESHOLD_BYTES`：API 大响应 warning 阈值，默认 1 MiB；日志只记录 method/path/status/bytes/duration/project/cache，不记录 query、鉴权或正文。
- `LITE_MAX_ACTIVE_REQUESTS` / `LITE_MAX_REQUEST_BYTES` / `LITE_MAX_DECOMPRESSED_BYTES`：默认 64 个活动请求、16 MiB 上传、32 MiB OTLP 解压输出。完整边界及错误语义见 [运行时内存边界](./docs/runtime-memory-limits.md)。
- `LANGFUSE_MODE`：运行模式（固定 `lite`，server 启动时自动设置）。
- `PERIFUSE_HOME`：全局数据目录（默认 `~/.peri-fuse`），所有 SQLite 数据库、salt、encryption key 存放于此。
- `DATABASE_URL`：Prisma SQLite 路径（默认 `<PERIFUSE_HOME>/langfuse.db`）。
- `LANGFUSE_SQLITE_DB_PATH`：遥测 SQLite 路径（默认 `<PERIFUSE_HOME>/telemetry.db`）。
- `SALT`：API Key 哈希盐值（自动生成并持久化到 `<PERIFUSE_HOME>/.salt`，生产环境建议手动设置）。

### Gateway

- `GATEWAY_PORT`：Gateway 端口（默认 4100）。
- `GATEWAY_DB_URL`：Gateway SQLite 路径（默认 `<PERIFUSE_HOME>/gateway.db`）。
- `GATEWAY_ENCRYPTION_KEY`：Provider API Key 加密密钥（64 字符 hex，自动生成并持久化到 `<PERIFUSE_HOME>/.encryption-key`）。
- `GATEWAY_LOG_REQUESTS`：是否记录请求日志（默认 true）。
- `GATEWAY_FLUSH_INTERVAL_MS` / `GATEWAY_DAILY_FLUSH_INTERVAL_MS`：兼容保留，已不影响记账；每次请求结束时同步提交 SQLite 事务。
- `GATEWAY_MAX_ACTIVE_REQUESTS` / `GATEWAY_MAX_REQUEST_BYTES`：独立 Gateway 默认 64 个活动请求、16 MiB 上传；内嵌 Gateway 使用 server 的 `LITE_*` 上限。
- `PERIFUSE_ENDPOINT`：PeriFuse 可观测性上报端点（可选）。
- `PERIFUSE_PUBLIC_KEY` / `PERIFUSE_SECRET_KEY`：上报鉴权（可选）。
