# syntax=docker/dockerfile:1
# =============================================================================
# ZED_BOT - shared image for the api, bot and worker services.
#
# All three services build from this one Dockerfile; docker-compose.yml picks
# the process per service via `command:` (node apps/<app>/dist/index.js).
# Identical build steps mean the three images share every layer.
# =============================================================================

FROM node:22-alpine AS base
RUN npm install -g pnpm@10.4.1
WORKDIR /repo

# --- Full install + compile ---------------------------------------------------
FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/worker/package.json apps/worker/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/panel-adapters/package.json packages/panel-adapters/
COPY packages/payments/package.json packages/payments/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @zedbot/database exec prisma generate
RUN pnpm -r run build

# --- Production-only dependencies ---------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/worker/package.json apps/worker/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/panel-adapters/package.json packages/panel-adapters/
COPY packages/payments/package.json packages/payments/
RUN pnpm install --prod --frozen-lockfile

# --- Runtime -------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# PostgreSQL 16 client tools (pg_dump/pg_restore/psql) so the worker can
# create and verify database backups inside its own container. The major
# version is pinned to match the postgres:16-alpine server in
# docker-compose.yml. Since Alpine 3.23 the postgresql16 aport lives in the
# community repository, which node:22-alpine (Alpine 3.24) enables by
# default. The CI docker-backup-smoke job asserts `pg_dump --version`
# reports 16.x, so a base-image bump that drops PG16 fails loudly here.
RUN apk add --no-cache postgresql16-client
COPY --from=prod-deps /repo ./
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/database/dist packages/database/dist
COPY --from=build /repo/packages/panel-adapters/dist packages/panel-adapters/dist
COPY --from=build /repo/packages/payments/dist packages/payments/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/bot/dist apps/bot/dist
COPY --from=build /repo/apps/worker/dist apps/worker/dist
# The Prisma schema ships in the image so `prisma migrate deploy` can run in a
# one-off container (scripts/migrate.sh), and the client is generated against
# the runtime node_modules tree.
COPY packages/database/prisma packages/database/prisma
RUN pnpm --filter @zedbot/database exec prisma generate
USER node
CMD ["node", "apps/api/dist/index.js"]
