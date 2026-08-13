# Peri-Fuse standalone image — SQLite-backed, zero external infra.
# Build:  docker build -t peri-fuse .
# Run:    docker run -p 23332:23332 -v peri-fuse-data:/app/data peri-fuse

# ---------- base ----------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="$PNPM_HOME:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---------- toolchain ----------
# Native-build toolchain (better-sqlite3 fallback compile). A standalone stage
# so deps and runtime share the same cached layer — installed only once.
FROM base AS toolchain
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# ---------- deps ----------
# Full dependency install (dev included) so every workspace package can build.
FROM toolchain AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
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
FROM toolchain AS runtime
ENV NODE_ENV=production \
    LITE_SERVER_PORT=23332 \
    PERIFUSE_HOME=/app/data \
    PNPM_HOME="/pnpm" \
    PATH="$PNPM_HOME:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
# Production deps only: @peri-fuse/server plus its workspace dependency chain
# (shared, gateway). better-sqlite3 is rebuilt via pnpm onlyBuiltDependencies.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @peri-fuse/server...

# Compiled artifacts. web/dist is placed at packages/server/dist/web so the
# server serves the SPA via its bundled-context lookup path (dist/web).
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/drizzle /app/packages/shared/drizzle
COPY --from=build /app/packages/gateway/dist /app/packages/gateway/dist
COPY --from=build /app/packages/gateway/drizzle /app/packages/gateway/drizzle
COPY --from=build /app/packages/server/dist /app/packages/server/dist
COPY --from=build /app/packages/web/dist /app/packages/server/dist/web

EXPOSE 23332
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:23332/api/public/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
