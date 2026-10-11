# AGENTS.md

Monorepo-level guidance for AI coding agents (Claude, Codex, Copilot, etc.).
For detailed architecture, conventions, and environment setup, see [CLAUDE.md](./CLAUDE.md).

## Project Identity

Langfuse Lite (`peri-fuse`) — self-contained LLM observability + proxy gateway.
Embedded Turso + Drizzle backend by default, with optional remote Turso URL/token configuration. No external infrastructure is required. Bun >= 1.4.2 is the product runtime; Node.js >= 22.12.0 is required for the build/test toolchain. pnpm monorepo.

## Packages

| Package | Name | Role |
|---------|------|------|
| `packages/shared` | `@peri-fuse/shared` | Domain logic, Drizzle + embedded Turso DB, ingestion, OTLP |
| `packages/server` | `@peri-fuse/server` | Hono HTTP server (production port 23332; dev port 23432) |
| `packages/gateway` | `@peri/gateway` | LLM proxy gateway (port 4100) |
| `packages/web` | `@peri-fuse/web` | React SPA dashboard |
| `packages/cli` | `peri-fuse` | CLI service manager |

## Critical Rules

1. **No external infra** — never introduce Redis, ClickHouse, S3, BullMQ, or any service requiring separate deployment.
2. **Project isolation** — all Gateway resources are scoped by `projectId`. Every query/write must filter or assign `projectId`. See [CLAUDE.md § Gateway 统一鉴权与项目隔离](./CLAUDE.md#gateway-统一鉴权与项目隔离核心规范).
3. **Auth model** — Gateway uses unified project-scoped API keys (Bearer/Basic). No global admin key exists.
4. **SDK compatibility** — `/api/public/*` endpoints must remain backward-compatible with Langfuse SDK.
5. **File size** — single file must not exceed 500 lines; refactor module boundaries before exceeding.
6. **Runtime split** — the product surface (`server`, `gateway`, CLI daemon, Docker `CMD`/`HEALTHCHECK`) runs on Bun >= 1.4.2; the build/test toolchain (pnpm, tsc, esbuild, biome, vite, vitest) runs on Node >= 22.12.0. The CLI suite uses `bun test`, every other suite uses Vitest on Node. The shared `src/db/sqlite*.test.ts` suite is the deliberate exception: it activates only under Bun (`skipIf` guard) and runs with the documented Bun command in [docs/sqlite-engine.md](./docs/sqlite-engine.md); do not move any other Vitest suite to Bun. See [docs/bun-runtime.md](./docs/bun-runtime.md).

## Quick Verification

```bash
pnpm run typecheck && pnpm run lint && pnpm run test
```

Package-specific:
```bash
pnpm --filter @peri/gateway run test       # Gateway (31 integration tests, Vitest/Node)
pnpm --filter @peri-fuse/server run test   # Server (Vitest/Node)
pnpm --filter peri-fuse run test           # CLI lifecycle suite (bun test)
pnpm --filter @peri-fuse/web run build     # Web production build
```

## Before You Commit

- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run lint` passes
- [ ] Relevant package tests pass
- [ ] No new `as any` without justification
- [ ] Gateway changes include project-isolation test coverage

## Package-Level AGENTS.md

- [`packages/shared/AGENTS.md`](./packages/shared/AGENTS.md) — shared package specifics
- [`packages/gateway/AGENTS.md`](./packages/gateway/AGENTS.md) — gateway specifics
