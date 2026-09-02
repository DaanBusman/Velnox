# syntax=docker/dockerfile:1.7
#
# Velnox web image.
#
# Next.js standalone output, so the runtime layer carries only the server and the
# modules it actually traced — not the build toolchain.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/opt/corepack
WORKDIR /app

# See the note in backend.Dockerfile: corepack downloads the package manager on
# first use, which fails on a network-isolated or air-gapped host.
COPY package.json ./
RUN corepack enable && \
    corepack prepare --activate && \
    chmod -R a+rX "$COREPACK_HOME"

# ---------------------------------------------------------------------------
FROM base AS build
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    VELNOX_STANDALONE=1

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/db/package.json ./packages/db/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/shared/package.json ./packages/shared/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @velnox/web... run build

# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

ARG VELNOX_VERSION=0.0.0-dev
ARG VELNOX_BUILD_COMMIT=unknown
ENV VELNOX_VERSION=${VELNOX_VERSION} \
    VELNOX_BUILD_COMMIT=${VELNOX_BUILD_COMMIT}

# The tracer was rooted at the repository, so the standalone bundle mirrors the
# workspace layout: server.js sits under apps/web, node_modules at the top.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
