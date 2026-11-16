# syntax=docker/dockerfile:1.7
# Build of the single `tix` image (web + worker + realtime behind a built-in proxy on :8080, see
# docker/supervisor):
#   docker build -t tix .

ARG NODE_IMAGE=node:24-alpine

# ─── Base: Node + pnpm (version pinned by package.json#packageManager) ───────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable pnpm
WORKDIR /repo

# ─── Dependencies (cached until a manifest or the lockfile changes) ─────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/realtime/package.json apps/realtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/redis/package.json packages/redis/package.json
COPY packages/core/package.json packages/core/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# ─── Build ──────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @tix/worker build \
 && pnpm --filter @tix/realtime build \
 && pnpm --filter @tix/web build \
 && node -p "require('/repo/packages/core/node_modules/sharp/package.json').version" > /sharp-version

# ─── Runtime: the single `tix` image (default target, keep it LAST) ─────────
# One container runs the web server, the realtime gateway and the worker under a small supervisor
# (docker/supervisor) that is also the public HTTP entry on :8080 (/socket.io -> realtime, the rest
# -> web). TLS is terminated by the operator's own reverse proxy. Layout:
#   /app/web        Next.js standalone output        /app/worker/dist    worker + migrate/seed/create-admin
#   /app/realtime   Socket.io gateway bundle         /app/migrations     SQL migrations
#   /app/supervisor entrypoint, proxy, env contract  /app/fonts          Noto Sans for PDFs
#   /data           the only volume (secrets, file storage)
FROM ${NODE_IMAGE} AS app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    REDIS_KEY_PREFIX=tix \
    MIGRATIONS_DIR=/app/migrations \
    TIX_FONT_DIR=/app/fonts \
    TIX_APP_DIR=/app \
    TINI_SUBREAPER=1
WORKDIR /app
# tini is PID 1 (signal forwarding, zombie reaping; TINI_SUBREAPER also keeps it quiet under `init: true`). PostgreSQL client tools for backups: their
# major version must match the server (postgres:18), so the build fails otherwise.
RUN apk add --no-cache tini postgresql18-client \
 && pg_dump --version | grep -q 'pg_dump (PostgreSQL) 18'
# `sharp` is native: external to the worker bundle and traced into the Next standalone output.
# /app/node_modules/sharp serves the worker (resolved upwards from /app/worker/dist); the web
# server prefers its own traced copy. Same version the lockfile resolved.
COPY --from=build /sharp-version /tmp/sharp-version
RUN npm install --omit=dev --no-save --no-audit --no-fund --ignore-scripts=false "sharp@$(cat /tmp/sharp-version)" \
 && npm cache clean --force \
 && rm -rf /tmp/sharp-version /root/.npm
COPY --from=build /repo/apps/web/.next/standalone ./web
COPY --from=build /repo/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=build /repo/apps/web/public ./web/apps/web/public
COPY --from=build /repo/apps/worker/dist ./worker/dist
COPY --from=build /repo/apps/realtime/dist ./realtime/dist
COPY --from=build /repo/packages/db/migrations ./migrations
COPY --from=build /repo/packages/core/assets/fonts ./fonts
COPY docker/supervisor/supervisor.mjs docker/supervisor/env.mjs docker/supervisor/proxy.mjs docker/supervisor/children.mjs docker/supervisor/pool.mjs docker/supervisor/sizing.mjs ./supervisor/
COPY VERSION ./VERSION
# Only /data and Next's runtime cache are writable; the server bundles stay root-owned.
RUN mkdir -p /data/secrets /data/storage /app/web/apps/web/.next/cache \
 && chown -R node:node /data /app/web/apps/web/.next/cache
USER node
VOLUME /data
EXPOSE 8080
# Generous start period: migrations may run before the application answers.
HEALTHCHECK --interval=15s --timeout=6s --start-period=120s --retries=3 \
  CMD ["node", "/app/supervisor/supervisor.mjs", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/supervisor/supervisor.mjs"]
CMD ["serve"]
