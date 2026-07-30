# Peri-Fuse

A lightweight, self-contained LLM observability server — the open-source platform for tracing, evaluating, and debugging AI applications.

Peri-Fuse runs entirely on **SQLite** with no external dependencies (no ClickHouse, Redis, S3, or BullMQ). It's designed for local development, small teams, and edge deployments.

## Features

- LLM observability (traces, spans, generations, scores)
- OpenTelemetry (OTLP) ingestion
- Public REST API compatible with Langfuse SDKs
- Lightweight web dashboard (Vite + React)
- Single-binary deployment via Hono HTTP server

## Quick Start

```bash
# Install dependencies
pnpm install

# Generate Prisma client
pnpm --filter @peri-fuse/shared run db:generate

# Push database schema
pnpm --filter @peri-fuse/shared run db:push

# Start development servers (API + Web)
pnpm run dev
```

The API server starts at `http://localhost:3000` and the web dashboard at `http://localhost:5173`.

## Project Structure

```
peri-fuse/
├── packages/
│   ├── shared/       # Domain logic, DB access, adapters (SQLite)
│   ├── server/       # Hono HTTP server (REST API + OTLP)
│   └── web/          # Vite + React dashboard
├── LICENSE           # MIT
└── NOTICE            # Attribution to Langfuse GmbH
```

## Environment Variables

See [`.env.example`](.env.example) for all available options. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:.langfuse/langfuse.db` | SQLite database path |
| `PORT` | `3000` | API server port |
| `SALT` | (auto-generated) | Hash salt for API keys |

## Performance

Peri-Fuse is optimized to handle production-scale workloads on a single SQLite file. Benchmarked at **250K traces / 1.13M observations / 1.6 GB**:

| Endpoint | Latency | Notes |
|----------|---------|-------|
| Traces list | 6 ms | Indexed pagination |
| Observations list | 24 ms | Covering index scan |
| Sessions list | 44 ms | Two-phase query |
| Users list | 85 ms | Materialized aggregates |
| Dashboard | 219 ms | 30-day bounded analytics |
| Trace detail | 1 ms | PK lookup |
| Session detail | 26 ms | Batched observation fetch |

### Optimization techniques

- **Materialized `trace_metrics` table** — per-trace cost/token aggregates maintained incrementally on ingestion, eliminating full-table `GROUP BY` over millions of observation rows.
- **Two-phase pagination** — list endpoints first resolve the page of IDs using lightweight trace-level indexes, then JOIN metrics only for the selected page (avoids aggregating the entire dataset).
- **Batched observation fetch** — session detail loads all trace observations in a single `IN (...)` query instead of N+1 per-trace calls.
- **Time-bounded analytics** — dashboard model/level breakdowns are scoped to the last 30 days, preventing unbounded full-table scans.
- **Covering indexes** — purpose-built composite indexes (`start_time + total_cost`, `type + start_time + model`, etc.) allow index-only scans for aggregation queries.
- **`ANALYZE`-aware planner** — indexes are designed to avoid SQLite query-planner regressions from conflicting candidate indexes.

## License

MIT — see [LICENSE](LICENSE). Based on [Langfuse](https://github.com/langfuse/langfuse) by Langfuse GmbH.
