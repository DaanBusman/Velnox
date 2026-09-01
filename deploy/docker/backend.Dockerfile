# syntax=docker/dockerfile:1.7
#
# Velnox backend image.
#
# One image, two roles (docs/tech-decisions.md ADR-013): the `api` and `worker`
# services run this same image with different entrypoints. That halves build time
# and image storage in the air-gapped artifact, and guarantees both roles execute
# byte-identical domain code — a version skew between them would be a correctness
# bug, not an inconvenience.
#
# Debian rather than Alpine: Prisma's query engine wants glibc and OpenSSL 3, and
# Debian is the platform Velnox targets anyway.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    COREPACK_HOME=/opt/corepack
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Bake the package manager into the image.
#
# `corepack enable` only installs shims — the pnpm tarball is fetched from the
# npm registry on first use. The migrate container runs on the internal network
# with no route off the host, so that fetch fails and migrations never run. An
# air-gapped installation fails the same way, for the same reason. Pinning pnpm
# here means no runtime container ever needs the network to find its tools.
#
# The version comes from package.json's `packageManager` field, so it cannot
# drift from what the workspace declares. COREPACK_HOME is made world-readable
# because the runtime stage drops to the unprivileged `node` user.
COPY package.json ./
RUN corepack enable && \
    corepack prepare --activate && \
    chmod -R a+rX "$COREPACK_HOME"

# ---------------------------------------------------------------------------
FROM base AS build
ENV NODE_ENV=development

# Manifests first, so a source-only change does not re-resolve the dependency
# graph. The lockfile is committed, and --frozen-lockfile makes the build fail
# rather than silently drift from it.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/shared/package.json ./packages/shared/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# Only the backend graph. Building the web app here would pull its toolchain into
# an image that never serves a page.
RUN pnpm --filter @velnox/api... --filter @velnox/worker... run build

# ---------------------------------------------------------------------------
FROM base AS runtime

ARG VELNOX_VERSION=0.0.0-dev
ARG VELNOX_BUILD_COMMIT=unknown
ARG VELNOX_BUILD_TIME=""
ENV VELNOX_VERSION=${VELNOX_VERSION} \
    VELNOX_BUILD_COMMIT=${VELNOX_BUILD_COMMIT} \
    VELNOX_BUILD_TIME=${VELNOX_BUILD_TIME}

# The whole tree is copied, symlinks and all, because pnpm's node_modules layout
# is a graph of relative links that does not survive being taken apart. Stripping
# build-time dependencies is Phase 14 packaging work and is recorded in
# docs/known-gaps.md rather than half-done here.
#
# Ownership is set during the copy. A separate `RUN chown -R` would rewrite every
# file in a tree of this size into a second layer, roughly doubling the image —
# and it was heavy enough to take the BuildKit worker down when three services
# built it at once.
COPY --from=build --chown=node:node /app /app

USER node

EXPOSE 4000

# Node 22 has fetch built in, so the probe needs no extra package in the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
