# AGENTS.md — `@peri-fuse/shared`

Package-local guidance for AI agents. See root [AGENTS.md](../../AGENTS.md) and [CLAUDE.md](../../CLAUDE.md) for monorepo rules.

## Purpose

Shared domain logic, database access, ingestion pipeline, and OTLP processing used by `server`. Primary owner of the Drizzle metadata and telemetry schemas and embedded Turso adapter.

## Key Constraints

- **Lite mode only** — no Redis, ClickHouse, S3, BullMQ. Storage defaults to embedded Turso/in-memory/local-storage; optional remote Turso uses URL/token configuration.
- **Dual DB architecture** — `langfuse.turso.db` (Drizzle + embedded Turso, auth/metadata) + `telemetry.turso.db` (@tursodatabase/database, traces/observations/scores).
- **Export boundaries** — `src/index.ts` is frontend-safe; `src/server/index.ts` is server-only. Never leak server modules into the root barrel.

## Entry Points

| Path | Role |
|------|------|
| `src/index.ts` | Frontend-safe exports (types, zod schemas, domain models) |
| `src/server/index.ts` | Server-only barrel (repositories, adapters, auth, ingestion) |
| `src/db.ts` | Drizzle client singleton (historical `prisma` alias) |
| `src/env.ts` | Shared environment schema |
| `src/domain/` | Domain models and business rules |
| `src/server/adapters/` | Storage adapters (factory selects by LANGFUSE_MODE) |
| `src/server/auth/` | API key verification, permission types |
| `src/server/ingestion/` | Event ingestion pipeline (batch, model match, sampling) |
| `src/server/otel/` | OTLP protocol parsing and transformation |
| `src/server/repositories/` | Data access layer |
| `src/db/schema/` and `src/db/telemetry/` | Drizzle schema sources of truth |

## Commands

```bash
pnpm --filter @peri-fuse/shared run build        # tsc build
pnpm --filter @peri-fuse/shared run typecheck    # tsc --noEmit
pnpm --filter @peri-fuse/shared run db:generate  # Generate metadata + telemetry migrations
```

## Playbooks

### Drizzle schema change

1. Update `src/db/schema/` or `src/db/telemetry/`.
2. Run `pnpm run db:generate` and commit the generated migration folder. Startup applies pending migrations transactionally.
3. Update affected repository/query code under `src/server/repositories/`.
4. Run server tests: `pnpm --filter @peri-fuse/server run test`.

### Telemetry adapter change

1. Modify `src/server/adapters/sqlite-telemetry-adapter.ts`.
2. Update the Drizzle telemetry schema and generate migrations; use transaction handles for all writes and derived projections.
3. Run server integration tests to verify ingestion roundtrip.

### Export surface change

1. Decide: frontend-safe (`src/index.ts`) vs server-only (`src/server/index.ts`).
2. Update barrel file + `package.json#exports` if import path changed.
3. Update consuming imports in `server` package.
