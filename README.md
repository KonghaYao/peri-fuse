# Peri-Fuse

A lightweight, self-contained LLM observability server — the open-source platform for tracing, evaluating, and debugging AI applications.

Peri-Fuse runs entirely on **SQLite** with no external dependencies (no ClickHouse, Redis, S3, or BullMQ). It's designed for local development, small teams, and edge deployments.

## Features

- LLM observability (traces, spans, generations, scores)
- OpenTelemetry (OTLP) ingestion
- Public REST API compatible with Langfuse SDKs
- Lightweight web dashboard (Vite + React)
- Self-contained deployment through Docker or the repository-local service CLI
- MCP resources and HTTP integration through the built-in `/api/mcp` endpoint

## Quick Start

Choose the workflow that matches how you want to run Peri-Fuse.

### Docker

The included Compose configuration runs the published image and persists all data in `./data`:

```bash
docker compose up -d

# Verify the API, follow logs, or stop the service
curl http://localhost:23332/api/public/health
docker compose logs -f
docker compose down
```

Open the dashboard at `http://localhost:23332`. Port `23332` is used when
`LITE_SERVER_PORT` is absent from both the host environment and `.env`. Setting that variable
changes the container listener and published port together. `docker compose down` leaves the
bind-mounted `./data` directory intact.

### Source development

Source development requires Node.js 22 or newer and pnpm 10:

```bash
pnpm install
pnpm dev
```

The API runs at `http://localhost:23432`, and the Vite dashboard runs at
`http://localhost:5173` with `/api` proxied to the API server. SQLite schemas and the initial
workspace are created automatically when the server starts.

### Local background service

To manage a production build from this checkout as a background service:

```bash
pnpm install
pnpm build
pnpm svc:start
pnpm svc:status
pnpm svc:logs
pnpm svc:stop
```

These commands use the CLI built from this repository; they do not require a global npm
installation. The service defaults to `http://localhost:23332`, but the CLI loads `.env` and
honors `LITE_SERVER_PORT` when it is set.

## Project Structure

```
peri-fuse/
├── packages/
│   ├── shared/       # SQLite domain logic, ingestion, queries, and OTLP
│   ├── server/       # Hono HTTP server and production web host
│   ├── gateway/      # Project-scoped LLM proxy gateway
│   ├── web/          # Vite + React dashboard
│   └── cli/          # Background service manager
├── Dockerfile        # Multi-stage production image
├── docker-compose.yml
├── LICENSE            # MIT
└── NOTICE             # Attribution to Langfuse GmbH
```

## Environment Variables

See [`.env.example`](.env.example) for a ready-to-copy set of common options. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `LITE_SERVER_PORT` | `23332` | API and dashboard port. The root `pnpm dev` script explicitly uses `23432`. |
| `PERIFUSE_HOME` | `~/.peri-fuse` | Persistent data directory. The Docker image uses `/app/data`, bound to `./data` by Compose. |
| `DATABASE_URL` | `file:<PERIFUSE_HOME>/langfuse.db` | Auth and metadata SQLite database. |
| `LANGFUSE_SQLITE_DB_PATH` | `<PERIFUSE_HOME>/telemetry.db` | Trace, observation, and score SQLite database. |
| `SALT` | generated and persisted | API-key hash salt stored at `<PERIFUSE_HOME>/.salt` when unset. |
| `LITE_LARGE_RESPONSE_THRESHOLD_BYTES` | `1048576` | Response-size warning threshold in bytes. |
| `PERIFUSE_TELEMETRY_RETENTION_DAYS` | disabled | Optional retention period; unset or `0` disables automatic purging. |

The checked-in [`.env.example`](.env.example) explicitly selects port `23432` for source
development. Copying it unchanged also overrides the CLI and Compose defaults, so adjust or
comment out `LITE_SERVER_PORT` when you want the production default.

## MCP

Peri-Fuse exposes the Langfuse skill as MCP resources from the same server as the dashboard and
API. Start the production service with `pnpm svc:start` and configure an MCP client with
`http://localhost:23332/api/mcp`; source development uses `http://localhost:23432/api/mcp`. Send a
project-scoped API key using HTTP Basic authentication (`publicKey:secretKey`, base64 encoded).
The checked-in [`.mcp.json`](.mcp.json) contains both endpoints with placeholders. See
[`packages/langfuse-mcp/README.md`](packages/langfuse-mcp/README.md) for the optional Node stdio
adapter.

## HTTP routing behavior

The server serves a real file from the built web assets when the requested static path exists.
For known web pages, an explicit `Accept: text/html` `GET` or `HEAD` request receives the SPA
`index.html`. Unknown page/API paths, missing assets, and `/.well-known/*` discovery paths
receive a JSON 404 response; existing API authentication still returns its normal JSON errors.
OAuth discovery is not provided. The MCP endpoint remains
project-scoped Basic authentication with strict MCP `2026-07-28` handling; clients using the
`2025-11-25` protocol are not compatible.

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
