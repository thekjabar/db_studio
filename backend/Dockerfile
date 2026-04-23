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
# Install multiple pg_dump majors (14 / 15 / 16 / 17) from the upstream PGDG
# apt repo. The backup service detects the remote server's major version
# and picks the matching pg_dump binary — prevents "server version newer
# than pg_dump" failures when users point at a newer managed Postgres.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl tini gnupg lsb-release \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         postgresql-client-14 postgresql-client-15 postgresql-client-16 postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*
# Expose the majors so the backup service knows what's installed without shelling
# out to `ls`. Keep in sync with the package list above.
ENV DBSTUDIO_PG_DUMP_MAJORS="14 15 16 17"

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
