# syntax=docker/dockerfile:1.7
# Multi-target build for the monorepo:
#   docker build --target web    -t tix/web .
#   docker build --target worker -t tix/worker .   (also runs migrate/seed/create-admin)
#   docker build --target realtime -t tix/realtime .

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

# ─── Runtime: web (Next.js standalone server) ───────────────────────────────
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ─── Runtime: worker + database CLIs (self-contained esbuild bundles) ───────
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
# PostgreSQL client tools for backups (pg_dump / pg_restore / psql). Their major version must match
# the server (postgres:18): the built image has to report `pg_dump --version` 18.x (checked below).
# Alpine ships `postgresql18-client` since 3.23 (node:24-alpine is on 3.24); when NODE_IMAGE is
# changed, verify with `apk search postgresql18-client` for that base.
RUN apk add --no-cache postgresql18-client \
 && pg_dump --version | grep -q 'pg_dump (PostgreSQL) 18'
# `sharp` is native and therefore external to the bundle: install the exact version the
# lockfile resolved (recorded in the build stage) so import('sharp') resolves from /app.
COPY --from=build /sharp-version /tmp/sharp-version
RUN npm install --omit=dev --no-save --no-audit --no-fund --ignore-scripts=false       "sharp@$(cat /tmp/sharp-version)"  && npm cache clean --force  && rm -rf /tmp/sharp-version /root/.npm  && chown -R node:node /app
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
USER node
EXPOSE 8081
CMD ["node", "--enable-source-maps", "dist/index.mjs"]

# ─── Runtime: realtime gateway (Socket.io, self-contained esbuild bundle) ───
FROM ${NODE_IMAGE} AS realtime
ENV NODE_ENV=production \
    REALTIME_PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/realtime/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
