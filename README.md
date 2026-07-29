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

## License

MIT — see [LICENSE](LICENSE). Based on [Langfuse](https://github.com/langfuse/langfuse) by Langfuse GmbH.
