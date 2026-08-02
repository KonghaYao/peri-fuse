# AGENTS.md — `@peri/gateway`

Package-local guidance for AI agents. See root [AGENTS.md](../../AGENTS.md) and [CLAUDE.md](../../CLAUDE.md) for monorepo rules.

## Purpose

PeriGateway is a unified LLM proxy gateway: multi-provider routing, rate limiting, budget control, and request observability. Standalone Hono service on port 4100 with its own SQLite database (Drizzle ORM).

## Key Constraints

- **All resources are project-scoped.** Every table has `projectId`, every query filters by it.
- **No admin key.** All routes (proxy + admin) authenticate via project-scoped API keys (Bearer or Basic).
- **Auth is verified against the server's shared DB** (`api_keys` table in langfuse.db). Gateway never stores secrets itself.
- **Only PROJECT-scoped keys accepted.** ORGANIZATION keys → 403.

## Entry Points

| Path | Role |
|------|------|
| `src/index.ts` | Service entrypoint (must import `./env.js` first) |
| `src/app.ts` | Hono app assembly, `GatewayEnv` type definition |
| `src/middleware/auth.ts` | `unifiedAuth` — Bearer/Basic, SHA-256 fast path + bcrypt fallback |
| `src/db.ts` | Drizzle connection + `ensureSchema()` incremental migration |
| `src/db/schema.ts` | All 9 tables (Drizzle schema) |
| `src/router/` | Model resolver + routing strategies |
| `src/routes/proxy/` | Data plane (chat, messages, models) |
| `src/routes/admin/` | Control plane (providers, credentials, models, keys, budgets, usage, logs, audit) |
| `src/hooks/` | Hook system (parallel-limiter, rate-limiter, budget-limiter, logger) |
| `src/spend/` | SpendFlusher, budget reset |
| `drizzle/` | SQL migration files |

## Adding a New Resource

1. Add table in `src/db/schema.ts` with `projectId: text("projectId").notNull()` + index.
2. Write incremental SQL migration in `drizzle/` (idempotent, use PRAGMA checks).
3. Update `ensureSchema()` detection logic in `src/db.ts`.
4. Create route in `src/routes/admin/`, read `c.get("projectId")` for all queries.
5. Add cross-project isolation test in `test/integration.test.ts`.

## Commands

```bash
pnpm --filter @peri/gateway run dev        # Dev mode (tsx watch, port 4100)
pnpm --filter @peri/gateway run test       # Integration tests (vitest)
pnpm --filter @peri/gateway run typecheck  # tsc --noEmit
pnpm --filter @peri/gateway run build      # tsc → dist/
```

## Testing

- Single file: `test/integration.test.ts` (31 tests).
- Uses mock LLM server + temp SQLite DBs (`/tmp/peri-gateway-*.db`).
- Covers: auth (Bearer/Basic/scope rejection), proxy (stream/non-stream/Anthropic), multi-project isolation, rate limiting, budget, full lifecycle.
- Run after any route or schema change.

## Migration Rules

- Migrations are hand-written SQL in `drizzle/`, executed idempotently at startup.
- Detection: `PRAGMA table_info('TableName')` to check if column exists.
- SQLite limitation: `ALTER TABLE ADD COLUMN` cannot add `NOT NULL` without default — use nullable + backfill + recreate pattern.
- Unique constraints: drop old index → create new composite index.
