# Embedded Turso storage

All three local databases use `@tursodatabase/database@0.8.2` (the embedded
Turso engine, not libSQL or a cloud client). Drizzle ORM and Drizzle Kit are pinned
to `1.0.0-rc.5-5935859`, whose async adapter supports this engine's transaction
handles. Upgrades must pass transaction, worker, ingestion and SDK regression tests.
No token, remote URL or separately deployed infrastructure is required.
Node.js 22.12.0 or newer is required because the CommonJS server and CLI load
the official ESM driver through Node's native require-ESM support.

## Fresh databases only

Defaults under `PERIFUSE_HOME` are `langfuse.turso.db`, `telemetry.turso.db`, and
`gateway.turso.db`. Existing environment variable names remain supported:
`DATABASE_URL`, `LANGFUSE_SQLITE_DB_PATH`, and `GATEWAY_DB_URL`.
Local paths and optional remote Turso URLs are accepted. Existing legacy databases are rejected before
serving requests; they are neither converted nor deleted. Keep the old files if
you need their history, and choose new paths for this release. New empty databases
receive committed baselines automatically. Subsequent generated migrations are
applied atomically and recorded in `_perifuse_migrations`.

For an existing better-sqlite3 installation, use
`bash scripts/migrate-legacy-db.sh --offline` after stopping every writer. This
explicit migration reads legacy DB/WAL files without replacing them, copies data
in bounded transactions, preserves key files and rebuilds search trigrams. See
[legacy database migration](legacy-db-migration.md) for inspection and resume steps.

## Optional remote Turso

Set `TURSO_DATABASE_URL=libsql://your-database-your-org.turso.io` and
`TURSO_AUTH_TOKEN=<database-token>` in `.env` or the process environment. Remote
configuration is also forwarded by the included Docker Compose file. Empty
optional environment variables are treated as unset. Remote
connections use the pinned `@tursodatabase/serverless@1.4.1` HTTP SDK through a
database compatibility layer; embedded mode retains the native driver.
`libsql://`, `http://` and `https://` URLs are supported, including base paths and query
parameters for reverse proxies, for example
`https://db.example.com/tenant/database?region=eu`. Protocol endpoints are appended
to the base path before the query string; parameters are preserved for reads,
transactions and worker requests. Configuration only trims surrounding whitespace
and selects the local or remote driver; URI validity, protocol support and
authentication are handled by the database SDK/server. Paths, query parameters,
URL credentials and fragments are not rejected by the configuration layer, but
passing configuration validation does not guarantee driver/server support.
Prefer the dedicated token environment variable rather than putting tokens in URLs.
Plain HTTP also supports remote hosts, including LAN and Docker service addresses.
For example, `http://database:8080/tenant/database?region=eu` is accepted. HTTP does
not encrypt database traffic or the authentication token; use it only on trusted
networks and use HTTPS for connections across untrusted networks.

The pinned HTTP SDK has a pnpm patch for endpoint URL construction. Both Docker
dependency stages copy `patches/` before installing dependencies, and the CLI
bundles the patched SDK. Keep the patch when upgrading until upstream preserves
paths and query parameters correctly.

A single URL stores metadata, telemetry and Gateway tables in one database.
For independent databases, configure any of these pairs:

| Domain | URL | Token override |
| --- | --- | --- |
| Metadata/auth | `TURSO_METADATA_DATABASE_URL` | `TURSO_METADATA_AUTH_TOKEN` |
| Telemetry/search | `TURSO_TELEMETRY_DATABASE_URL` | `TURSO_TELEMETRY_AUTH_TOKEN` |
| Gateway | `TURSO_GATEWAY_DATABASE_URL` | `TURSO_GATEWAY_AUTH_TOKEN` |

URL priority is domain override → global URL → legacy path variable → local
default. Token priority is domain override → global token. A domain URL may also
be a local path for hybrid deployments. Tokens are optional in configuration;
the server determines whether authentication is required. Connection/auth errors
do not create or fall back to local databases.
Existing local data is not copied to the remote database. Use a fresh remote
database: nonempty, unrecognized legacy databases are rejected as in local mode.
Startup creates and migrates tables and therefore requires write access.

Read and search workers receive the same remote configuration. Remote reads use
streaming HTTP cursors and retain row/byte/time limits; index writes and migrations
use dedicated transaction sessions with foreign keys enabled before BEGIN.
Remote read-only connections and streaming reads use the protocol's statement
description (`is_readonly`) to reject mutations, including writes with RETURNING
and CTE writes. They do not rely on `PRAGMA query_only`, which libSQL servers may
reject. Read-only execution uses the single-statement cursor, not SQL sequences.
Remote network latency and service limits apply to ingestion and search; use a
nearby database region. Local filesystem backup instructions do not apply to
remote storage: use Turso's database backup/export facilities instead.

`PERIFUSE_HOME` still stores salt, encryption keys, logs and other non-database
state. Preserve it, or explicitly configure stable `SALT` and
`GATEWAY_ENCRYPTION_KEY` when moving between machines. A URL/token alone does not
replace those encryption and API-key hashing settings.

Test configurations clear inherited `TURSO_*` settings so running the regression
suite cannot redirect test writes to a configured production database. Remote
integration tests start their own authenticated, disposable HTTP protocol server.

## Schema workflow

- Metadata: `packages/shared/src/db/schema/`, migrations in `packages/shared/drizzle/`.
- Telemetry: `packages/shared/src/db/telemetry/`, migrations in `packages/shared/telemetry-drizzle/`.
- Gateway: `packages/gateway/src/db/schema.ts`, migrations in `packages/gateway/drizzle/`.

Run `pnpm run db:generate` for shared schemas and
`pnpm --filter @peri/gateway exec drizzle-kit generate` for Gateway. Commit the
generated folder, including `migration.sql` and `snapshot.json`. Do not edit old
baselines or run Prisma schema push. The historical `prisma` export is only a
Drizzle alias. The CLI bundles all migrations and search worker helpers.

## Async and concurrency

All SQL operations are awaited. Inside a transaction, use only its provided
transaction handle; issuing work through the parent connection can deadlock.
File handles, read workers and search workers enable the engine's experimental
`multiprocess_wal` option consistently; memory databases omit it. Spend acceptance
waits for the accounting transaction to commit, and shutdown drains in-flight work.
Gateway physical table names are lowercase to avoid the engine's mixed-case
qualified-column UPDATE limitation; API resource names are unchanged.

Compressed IO is decoded in application/worker code, with codec, raw-size and
inflate limits enforced. There are no SQL UDFs, temporary reader views, triggers
or FTS virtual tables. Session search uses project-scoped Unicode trigram rows,
candidate intersection and exact normalized substring verification. Search dirty
revisions, ingestion field versions, daily-stat dirty days and trace metrics are
updated in the same transaction as entity mutations.

## Maintenance

Stop writers and workers before taking a filesystem backup; preserve database
and WAL files together. Do not rely on copying only a live database file.
Maintenance scripts import the built shared package: run
`pnpm --filter @peri-fuse/shared run build` first. Pruning and stress teardown use
the telemetry adapter so derived state stays consistent. `--dry-run` is read-only
and never creates a missing database. In-place `--vacuum` is explicitly rejected
by the pruning script; use an offline export/rebuild instead. Benchmark scripts
use the new engine and do not load the removed driver.
