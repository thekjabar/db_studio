# syntax=docker/dockerfile:1.7
# Single-stage build modeled on D:/Galina/galina-ecom-admin-api/Dockerfile.
# Trades a larger final image for much faster builds:
#   - no multi-stage copy-out
#   - no `pnpm prune --prod` (saves ~130s on slow disks for ~150 MB)
#   - alpine base (much smaller pull + apk is faster than apt)
# pg_dump majors 14-17 still required for the backup service.

FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Build toolchain for native modules (argon2, better-sqlite3, ssh2 cpu-features).
# Kept in the same image because we don't prune later.
RUN apk add --no-cache \
      python3 make g++ openssl ca-certificates curl tini

# pg_dump for the backup feature. Alpine ships postgresql17-client only.
# Note: this means dumps of remote Postgres servers older than 17 may fail.
# Add older majors here if you support those servers.
RUN apk add --no-cache postgresql17-client
ENV DBSTUDIO_PG_DUMP_MAJORS="17"

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Layer 1: dependencies — cached unless package.json / lockfile changes.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --prefer-offline

# Layer 2: prisma generate — cached unless schema changes.
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
RUN DATABASE_URL="postgresql://u:p@localhost:5432/d" pnpm exec prisma generate

# Layer 3: build — only re-runs on code changes.
COPY src ./src
COPY scripts ./scripts
COPY nest-cli.json tsconfig.json ./
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm exec nest build

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
