# CLAUDE.md

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

- 主要能力：LLM 可观测性（traces/spans/generations/scores）、OpenTelemetry (OTLP) 数据接入、兼容 Langfuse SDK 的 REST API、轻量 Web 仪表盘。
- pnpm monorepo + Turbo 构建编排，Node.js >= 22。
- `packages/` 包含 3 个内部包：`shared`、`server`、`web`；跨包能力应通过包导出的稳定接口复用，不得依赖包内实现细节。

### 后端地图（packages/server）

- `src/index.ts`：服务入口，强制 lite 模式并启动 Hono HTTP 服务。
- `src/env.ts`：环境引导，设置 `LANGFUSE_MODE=lite`、SQLite 路径默认值。**必须最先导入**。
- `src/app.ts`：Hono 应用装配层（路由注册、CORS、全局错误处理、SPA 静态资源托管）。
- `src/auth.ts`：HTTP Basic 认证中间件（publicKey:secretKey）。
- `src/routes/`：API 路由（ingestion、otel、traces、observations、scores、sessions、dashboard、health）。
- `src/schemas/`：请求/响应 Zod schema。
- `src/shaping/`：数据整形层（将存储数据转换为 API 响应格式）。
- `src/__tests__/`：后端集成测试（Vitest）。

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

- `src/main.tsx`：应用入口（React Query + BrowserRouter）。
- `src/App.tsx`：路由定义（react-router-dom v7）。
- `src/pages/`：页面组件（dashboard、traces、sessions、observations、scores、settings）。
- `src/components/`：通用 UI 与业务组件。
- `src/components/ui/`：基础 UI 组件（Radix UI + Tailwind）。
- `src/lib/api.ts`：类型化 REST 客户端（调用 `/api/public/*`）。
- `src/lib/types.ts`：前端类型定义。
- `src/store/auth.ts`：认证状态管理（localStorage 持久化）。
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
pnpm run dev:server           # 仅后端开发（port 23332）
pnpm run dev:web              # 仅前端开发（Vite port 5173，代理 /api → 23332）
pnpm run build                # 全量构建（shared → server → web）
pnpm run typecheck            # 全包 TypeScript 类型检查
pnpm run lint                 # Biome lint + format 检查
pnpm run lint:fix             # Biome 自动修复
pnpm run test                 # 全包 Vitest 测试
pnpm run db:generate          # Prisma generate（schema → client）
pnpm run db:push              # Prisma db push（schema → SQLite，开发用）
```

### 按变更类型验证

- 后端改动：运行 `pnpm --filter @peri-fuse/server run test`，完成后运行 `pnpm run typecheck && pnpm run lint`。
- 共享层改动：运行 `pnpm --filter @peri-fuse/shared run test`，再运行依赖它的包的测试。
- 前端改动：运行 `pnpm --filter @langfuse-lite/web run build`（生产构建不可省略，因为后端从 `packages/web/dist/` 挂载静态资源）。
- 数据库改动：修改 `packages/shared/prisma/schema.sqlite.prisma` → `pnpm run db:generate` → `pnpm run db:push` → 运行相关测试。
- 全量检查：`pnpm run typecheck && pnpm run lint && pnpm run test`。

## 架构边界与模块契约

### 依赖方向

`server → shared`，`web`（独立，通过 HTTP API 与 server 通信）。

- server 只负责协议接入（Hono 路由）、认证、参数校验和响应映射。
- shared 承载领域逻辑、数据访问、摄入管线和 OTLP 处理。
- web 是纯前端 SPA，通过 `/api/public/*` REST API 与 server 交互，不直接依赖 shared。
- 禁止 server 反向依赖 web，禁止 web 直接导入 shared 内部实现。

### API 边界

- 所有公开 API 挂载在 `/api/public/*`，兼容 Langfuse SDK 协议。
- OTLP 入口：`/api/public/otel/v1/traces`（protobuf + JSON）。
- 摄入入口：`/api/public/ingestion`（批量事件）。
- 认证方式：HTTP Basic（`publicKey:secretKey`），由 `authMiddleware` 统一处理。
- 响应格式遵循 Langfuse API 约定（分页使用 `meta: { page, limit, totalItems, totalPages }`）。
- 新增接口必须保持与 Langfuse SDK 的向后兼容性。

### 前端边界与体验

- 请求统一通过 `src/lib/api.ts` 的 `apiFetch<T>()`；已处理 auth header、JSON 解析和错误标准化。
- 数据获取使用 TanStack React Query（`useQuery`），遵循现有 staleTime 和 retry 配置。
- 基础组件优先复用 `src/components/ui/`（Radix UI 原语 + CVA 变体）。
- 通用图标使用 `lucide-react`。
- 样式使用 Tailwind CSS 4（`@tailwindcss/postcss`），工具类优先。
- 页面流程必须覆盖 loading（Skeleton）、empty、error 和 retry 状态。
- 开发时 Vite 代理 `/api` 到 `http://localhost:23332`；生产时 server 直接托管 `web/dist`。

### 存储层

- 双 SQLite 数据库架构：
  - `langfuse.db`（Prisma）：认证、项目、组织、API Key 等元数据。
  - `telemetry.db`（better-sqlite3）：traces、observations、scores 等遥测数据。
- 存储适配器通过 `packages/shared/src/server/adapters/factory.ts` 按 `LANGFUSE_MODE` 选择。
- Lite 模式使用 `sqlite-telemetry-adapter`、`in-memory-cache-adapter`、`in-memory-queue-adapter`、`local-storage-adapter`。
- 不得在 lite 路径中引入对 Redis/S3/ClickHouse/BullMQ 的运行时依赖。

## 数据库与迁移

- Prisma schema 真相来源：`packages/shared/prisma/schema.sqlite.prisma`。
- 标准流程：修改 schema → `pnpm run db:generate` → `pnpm run db:push`（开发）→ 运行相关测试。
- 遥测数据库（telemetry.db）的表结构由 `sqlite-telemetry-adapter.ts` 中的 DDL 管理。
- 迁移设计必须考虑已有数据兼容性和幂等性。

## 质量、测试与长期维护

### 测试

- 后端测试位于 `packages/server/src/__tests__/`，共享层测试与源码同目录（`*.test.ts`）。
- 测试框架为 Vitest；后端集成测试使用 `packages/server/src/__tests__/global-setup.ts` 初始化临时数据库。
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

环境变量以 `.env.example` 为参考，运行时由 `packages/server/src/env.ts` 和 `packages/shared/src/env.ts` 解析。关键变量：

- `LITE_SERVER_PORT`：服务端口（默认 23332）。
- `LANGFUSE_MODE`：运行模式（固定 `lite`，server 启动时自动设置）。
- `DATABASE_URL`：Prisma SQLite 路径（默认 `file:.langfuse/langfuse.db`，相对路径从项目根解析）。
- `LANGFUSE_SQLITE_DB_PATH`：遥测 SQLite 路径（默认 `.langfuse/telemetry.db`）。
- `SALT`：API Key 哈希盐值（生产环境必须设置为随机字符串）。
