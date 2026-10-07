# Peri-Fuse standalone image — SQLite-backed, zero external infra.
# Build:  docker build -t peri-fuse .
# Run:    docker run -p 23332:23332 -v peri-fuse-data:/app/data peri-fuse

# ---------- base ----------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---------- deps ----------
# Full dependency install (dev included) so every workspace package can build.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/langfuse-mcp/package.json packages/langfuse-mcp/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
COPY packages ./packages
RUN pnpm run build

# ---------- runtime ----------
FROM base AS runtime
ENV NODE_ENV=production \
    LITE_SERVER_PORT=23332 \
    PERIFUSE_HOME=/app/data \
    PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
# Production deps only: @peri-fuse/server plus its workspace dependency chain
# (shared, gateway), including the platform-specific prebuilt Turso native module.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/langfuse-mcp/package.json packages/langfuse-mcp/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @peri-fuse/server...

# Compiled artifacts. web/dist is placed at packages/server/dist/web so the
# server serves the SPA via its bundled-context lookup path (dist/web).
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/drizzle /app/packages/shared/drizzle
COPY --from=build /app/packages/shared/telemetry-drizzle /app/packages/shared/telemetry-drizzle
COPY --from=build /app/packages/gateway/dist /app/packages/gateway/dist
COPY --from=build /app/packages/gateway/drizzle /app/packages/gateway/drizzle
COPY --from=build /app/packages/langfuse-mcp/dist /app/packages/langfuse-mcp/dist
COPY --from=build /app/packages/langfuse-mcp/skills /app/packages/langfuse-mcp/skills
COPY --from=build /app/packages/server/dist /app/packages/server/dist
COPY --from=build /app/packages/web/dist /app/packages/server/dist/web
COPY scripts/migrate-legacy-db.sh /app/scripts/migrate-legacy-db.sh
COPY scripts/legacy-migration /app/scripts/legacy-migration

EXPOSE 23332
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "const { resolveLiteServerPort } = require('./packages/server/dist/port.js'); const port = resolveLiteServerPort(process.env.LITE_SERVER_PORT); fetch('http://127.0.0.1:' + port + '/api/public/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "packages/server/dist/index.js"]
