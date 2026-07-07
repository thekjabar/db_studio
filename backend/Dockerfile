# syntax=docker/dockerfile:1.7
# Single-stage build modeled on D:/Galina/galina-ecom-admin-api/Dockerfile.
# Trades a larger final image for much faster builds:
#   - no multi-stage copy-out
#   - no `pnpm prune --prod` (saves ~130s on slow disks for ~150 MB)
#   - debian-slim (glibc) — DuckDB ships only glibc prebuilds, no musl
#     so alpine isn't an option here.

FROM node:26-bookworm-slim

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Build toolchain for native modules + pg_dump majors 14-17 + tini for PID 1.
# postgresql-client-N comes from PGDG so we get all four majors the backup
# service can dispatch to depending on remote-server version.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ openssl ca-certificates curl tini gnupg lsb-release \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
         postgresql-client-14 postgresql-client-15 postgresql-client-16 postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*
ENV DBSTUDIO_PG_DUMP_MAJORS="14 15 16 17"

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
COPY nest-cli.json tsconfig.json .swcrc ./
# SWC (Rust) compiler — ~10x faster than tsc. Type-checking is skipped here
# (typeCheck:false in nest-cli.json) since CI / `tsc --noEmit` covers types.
RUN NODE_OPTIONS=--max-old-space-size=1536 pnpm exec nest build

EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
