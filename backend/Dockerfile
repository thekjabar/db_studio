# syntax=docker/dockerfile:1.7
# ---- Base ----
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ---- Deps (all, including dev) ----
FROM base AS deps
ENV NODE_ENV=development
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN --mount=type=cache,id=pnpm-dev,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile=false --prod=false && \
    ls node_modules/@nestjs/cli/bin/nest.js

# ---- Builder ----
FROM deps AS builder
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
RUN DATABASE_URL="postgresql://u:p@localhost:5432/d" pnpm prisma generate
COPY . .
# Sanity check — if .dockerignore or a COPY stomped on node_modules, fail here
# with a clear message instead of inside nest's loader.
RUN test -f node_modules/@nestjs/cli/bin/nest.js || (echo "FATAL: @nestjs/cli missing after COPY. Check .dockerignore." && exit 1)
RUN pnpm build
# Prune dev dependencies IN PLACE so the same node_modules tree (with its
# Prisma peer-link graph intact) survives. This is safer than copying a
# separately-installed prod node_modules from another stage — peer-dep hashes
# would mismatch the client generated during build.
RUN pnpm prune --prod

# ---- Runner ----
FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
