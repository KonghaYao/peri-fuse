# Peri-Fuse

A lightweight, self-contained LLM observability server — the open-source platform for tracing, evaluating, and debugging AI applications.

Peri-Fuse uses **embedded Turso + Drizzle** by default, with no external infrastructure (no ClickHouse, Redis, S3, or BullMQ). You can optionally replace local databases with remote Turso using a URL and auth token. It's designed for local development, small teams, and edge deployments.

This release initializes fresh `.turso.db` databases; existing SQLite files are not automatically converted or deleted. To preserve legacy data, stop the service and run `bash scripts/migrate-legacy-db.sh --offline`. See [legacy migration](docs/legacy-db-migration.md) for safe inspection, large-database handling and resuming, and [embedded Turso storage](docs/embedded-turso.md) for pinned versions and migrations.
Requires Bun 1.4.2 or newer to run the server, the gateway, and the service CLI. The build and
test toolchain (pnpm, TypeScript, Vite, Vitest) still runs on Node.js 22.12.0 or newer — see
[runtime requirements](docs/bun-runtime.md).

## Features

- LLM observability (traces, spans, generations, scores)
- OpenTelemetry (OTLP) ingestion
- Public REST API compatible with Langfuse SDKs
- Lightweight web dashboard (Vite + React)
- Self-contained deployment through Docker or the repository-local service CLI
- MCP resources and HTTP integration through the built-in `/mcp` endpoint

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

The production Docker image runs the server and its health check with Bun 1.4.2 on Debian,
and keeps Node.js 22 in the image for the one-off legacy SQLite migration
(`scripts/migrate-legacy-db.sh`, which mixes `node:sqlite` with the Turso driver).
Dependency installation and compilation use Node.js/pnpm build stages; the runtime image only
receives production dependencies and built assets.
The release workflow builds both `linux/amd64` and `linux/arm64` (Apple Silicon).

The dashboard defaults to light mode and automatically activates Default Project
on a fresh visit. Saved theme and valid project selections are preserved; stale
project selections are replaced before data pages load.

### Source development

Source development requires Bun 1.4.2 or newer to run the API server, Node.js 22.12.0 or newer
for the build/test toolchain, and pnpm 10:

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
installation. They launch the CLI with Bun, so the managed background server also runs on Bun.
The service defaults to `http://localhost:23332`, but the CLI loads `.env` and
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
| `DATABASE_URL` | `file:<PERIFUSE_HOME>/langfuse.turso.db` | Auth and metadata SQLite database. |
| `TURSO_DATABASE_URL` | unset | Optional remote Turso URL for all three database domains. |
| `TURSO_AUTH_TOKEN` | unset | Required auth token when a remote URL is configured. |
| `LANGFUSE_SQLITE_DB_PATH` | `<PERIFUSE_HOME>/telemetry.turso.db` | Trace, observation, and score SQLite database. |
| `SALT` | generated and persisted | API-key hash salt stored at `<PERIFUSE_HOME>/.salt` when unset. |
| `LITE_LARGE_RESPONSE_THRESHOLD_BYTES` | `1048576` | Response-size warning threshold in bytes. |
| `PERIFUSE_TELEMETRY_RETENTION_DAYS` | disabled | Optional retention period; unset or `0` disables automatic purging. |

To use remote Turso, add these settings to `.env` (or export them before starting the service):

```dotenv
TURSO_DATABASE_URL=libsql://your-database-your-org.turso.io
TURSO_AUTH_TOKEN=your-database-token
```

Metadata, telemetry, and Gateway then share that remote database, including search workers.
For separate databases or mixed local/remote storage, use `TURSO_METADATA_DATABASE_URL`,
`TURSO_TELEMETRY_DATABASE_URL`, or `TURSO_GATEWAY_DATABASE_URL`, with the corresponding
`TURSO_<ROLE>_AUTH_TOKEN` if needed. Role settings override global settings, which override
legacy local paths. Startup applies migrations to a fresh database; existing local data is
not uploaded. Connection/auth failures never silently fall back to local storage. Keep
`SALT` and `GATEWAY_ENCRYPTION_KEY` stable across hosts, or preserve `PERIFUSE_HOME`.
See [storage configuration](docs/embedded-turso.md) for details.

The checked-in [`.env.example`](.env.example) explicitly selects port `23432` for source
development. Copying it unchanged also overrides the CLI and Compose defaults, so adjust or
comment out `LITE_SERVER_PORT` when you want the production default.

## MCP

Peri-Fuse exposes the Langfuse skill as MCP resources from the same server as the dashboard and
API. Start the production service with `pnpm svc:start` and configure an MCP client with
`http://localhost:23332/mcp`; source development uses `http://localhost:23432/mcp`. The MCP
endpoint is a public read-only skill resource endpoint and requires no credentials. Data API
requests continue to use a project-scoped API key.
The checked-in [`.mcp.json`](.mcp.json) contains both local endpoints without authentication headers. See
[`packages/langfuse-mcp/README.md`](packages/langfuse-mcp/README.md) for the optional Node stdio
adapter.

## HTTP routing behavior

The server serves a real file from the built web assets when the requested static path exists.
For known web pages, an explicit `Accept: text/html` `GET` or `HEAD` request receives the SPA
`index.html`. Unknown page/API paths, missing assets, and `/.well-known/*` discovery paths
receive a JSON 404 response; existing API authentication still returns its normal JSON errors.
The MCP endpoint supports both MCP `2026-07-28` and stateless `2025-11-25` clients. It only
distributes skill resources; analysis scripts are instructions for the MCP client to run and are
never executed by the server. OAuth discovery is not provided.

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

Provenance: the table above was recorded at commit
[`66bc32b`](https://github.com/KonghaYao/peri-fuse/commit/66bc32b) (2026-07-30) without a documented
host, corpus, or measurement method, and the 1.6 GB dataset behind it is not checked in. Treat the
numbers as historical orientation, not as a reproducible result: they cannot be re-measured from
this repository, and the session list has since been rewritten. The harness-backed numbers below
are the ones to keep current.

### Reproducible session-list benchmark

`packages/server/src/__tests__/sessions-query-plan.test.ts` validates the session list against a
frozen pre-rewrite baseline on a 1,000-trace corpus (row-for-row equivalence plus query plans and
cache-miss latency). `packages/server/src/__tests__/sessions-scale-bench.test.ts` reuses the same
route capture on 100K/1M traces, and `sessions-scale-diagnostic.test.ts` measures the raw statement
cost beyond the read pool's 30s budget. The scale harnesses are opt-in, so the default test run
stays fast:

```bash
cd packages/server
npx vitest run src/__tests__/sessions-query-plan.test.ts                          # 1K equivalence + plan + latency
PERIFUSE_BENCH_TRACES=100000 npx vitest run src/__tests__/sessions-scale-bench.test.ts
PERIFUSE_BENCH_TRACES=1000000 npx vitest run src/__tests__/sessions-scale-bench.test.ts
# deep measurement (bypasses the 30s read-pool budget; prints full SQL, plans, raw statement ms):
PERIFUSE_READ_WORKERS=0 PERIFUSE_BENCH_TRACES=1000000 npx vitest run src/__tests__/sessions-scale-diagnostic.test.ts
```

The harnesses seed a dedicated project through the public ingestion API (1K) or a direct bulk loader
(100K/1M), run `ANALYZE`, and the benchmark samples 50 cache-miss requests of the default 50-row
page plus the underlying list/count statements. Measured 2026-10-11 on macOS, Apple silicon (18
cores, 48 GiB RAM), Node 26.9.0, default embedded Turso engine, throwaway `.test` database,
`X-Cache: MISS`, n=50 after 5 warmups (review §12 targets: request p95 ≤ 100 ms, p99 ≤ 250 ms).
Request figures are percentiles over the measured samples; statement figures are p50, except the 1M
entries, which are single deep-diagnostic measurements:

| Corpus | Scenario | Request p50 | Request p95 | Request p99 | list stmt | count stmt | §12 budget |
|--------|----------|-------------|-------------|-------------|---------------|----------------|------------|
| 1K traces / 200 sessions | default order | 3.39 ms | 23.23 ms | 44.42 ms | 2.69 ms | — | met |
| 1K traces / 200 sessions | `orderBy=totalCost.desc` | 3.76 ms | 9.52 ms | 23.23 ms | 2.59 ms | — | met |
| 100K traces / 20K sessions | default order | 46.03 ms | 57.91 ms | 78.14 ms | 29.92 ms | 14.06 ms | met |
| 100K traces / 20K sessions | `orderBy=totalCost.desc` | 134.75 ms | 152.74 ms | 155.51 ms | 115.15 ms | 15.46 ms | request p95 missed |
| 1M traces / 200K sessions | default order | route 503 | — | — | 214,020 ms | 1,469 ms | list statement exceeds the 30s read-pool budget |
| 1M traces / 200K sessions | `orderBy=totalCost.desc` | route 503 | — | — | >300 s, interrupted | — | list statement does not finish |

Notes:

- The metric-ranked sort aggregates every session's metrics before it can rank a page, so at 100K it
  already exceeds the p95 budget. That is the design tradeoff recorded in review §3.3; the planned
  `session_summary` projection is the follow-up if the budget must hold. The miss is not a
  single-run artifact: three runs landed p95 = 152.7, 175.1, and 188.7 ms (the table quotes the
  fastest run).
- At 1M traces the Turso planner flips the `trace_metrics` join from the `(project_id, trace_id)`
  primary-key index to `idx_trace_metrics_ts (project_id=?)`, so every outer row scans the project's
  whole metrics prefix (~900K entries): the default page statement needs ~214 s for 50 rows — 30 ms
  at 100K — and the route answers 503 once the read pool's 30 s statement budget expires. System
  SQLite 3.51.0 (CLI) plans the same SQL on the same database file with the primary-key index and
  executes it in ~3.8 s, so the flip costs roughly 56x here; fixing it removes the planner penalty
  but not the seconds-scale 1M aggregation, so the §12 budget still needs the materialized session
  projection. The flip reproduces across runs (both scenarios, `sqlite_stat1` populated), and system
  SQLite picks the primary-key index for both scenario queries.
- The 1K frozen-baseline (pre-rewrite) statement measures p50 ≈ 182–186 ms at 1K traces versus
  2.6–2.7 ms for the current page statement.

### Optimization techniques

- **Materialized `trace_metrics` table** — per-trace cost/token aggregates maintained incrementally on ingestion, eliminating full-table `GROUP BY` over millions of observation rows.
- **Two-phase pagination** — list endpoints first resolve the page of IDs using lightweight trace-level indexes, then JOIN metrics only for the selected page (avoids aggregating the entire dataset).
- **Batched observation fetch** — session detail loads all trace observations in a single `IN (...)` query instead of N+1 per-trace calls.
- **Time-bounded analytics** — dashboard model/level breakdowns are scoped to the last 30 days, preventing unbounded full-table scans.
- **Covering indexes** — purpose-built composite indexes (`start_time + total_cost`, `type + start_time + model`, etc.) allow index-only scans for aggregation queries.
- **`ANALYZE`-aware planner** — indexes are designed to avoid SQLite query-planner regressions from conflicting candidate indexes.

## License

MIT — see [LICENSE](LICENSE). Based on [Langfuse](https://github.com/langfuse/langfuse) by Langfuse GmbH.
