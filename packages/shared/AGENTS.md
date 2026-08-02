# AGENTS.md — `@peri-fuse/shared`

Package-local guidance for AI agents. See root [AGENTS.md](../../AGENTS.md) and [CLAUDE.md](../../CLAUDE.md) for monorepo rules.

## Purpose

Shared domain logic, database access, ingestion pipeline, and OTLP processing used by `server`. Primary owner of the Prisma schema (langfuse.db) and telemetry adapter (telemetry.db).

## Key Constraints

- **Lite mode only** — no Redis, ClickHouse, S3, BullMQ. All adapters are SQLite/in-memory/local-storage.
- **Dual DB architecture** — `langfuse.db` (Prisma, auth/metadata) + `telemetry.db` (better-sqlite3, traces/observations/scores).
- **Export boundaries** — `src/index.ts` is frontend-safe; `src/server/index.ts` is server-only. Never leak server modules into the root barrel.

## Entry Points

| Path | Role |
|------|------|
| `src/index.ts` | Frontend-safe exports (types, zod schemas, domain models) |
| `src/server/index.ts` | Server-only barrel (repositories, adapters, auth, ingestion) |
| `src/db.ts` | Prisma client singleton |
| `src/env.ts` | Shared environment schema |
| `src/domain/` | Domain models and business rules |
| `src/server/adapters/` | Storage adapters (factory selects by LANGFUSE_MODE) |
| `src/server/auth/` | API key verification, permission types |
| `src/server/ingestion/` | Event ingestion pipeline (batch, model match, sampling) |
| `src/server/otel/` | OTLP protocol parsing and transformation |
| `src/server/repositories/` | Data access layer |
| `prisma/schema.sqlite.prisma` | Prisma schema source of truth |

## Commands

```bash
pnpm --filter @peri-fuse/shared run build        # tsc build
pnpm --filter @peri-fuse/shared run typecheck    # tsc --noEmit
pnpm --filter @peri-fuse/shared run db:generate  # Prisma generate
pnpm run db:push                                 # Prisma db push (dev)
```

## Playbooks

### Prisma schema change

1. Update `prisma/schema.sqlite.prisma`.
2. Run `pnpm run db:generate` → `pnpm run db:push`.
3. Update affected repository/query code under `src/server/repositories/`.
4. Run server tests: `pnpm --filter @peri-fuse/server run test`.

### Telemetry adapter change

1. Modify `src/server/adapters/sqlite-telemetry-adapter.ts`.
2. DDL changes must be idempotent (CREATE TABLE IF NOT EXISTS / ALTER with existence check).
3. Run server integration tests to verify ingestion roundtrip.

### Export surface change

1. Decide: frontend-safe (`src/index.ts`) vs server-only (`src/server/index.ts`).
2. Update barrel file + `package.json#exports` if import path changed.
3. Update consuming imports in `server` package.
