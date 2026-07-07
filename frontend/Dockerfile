# syntax=docker/dockerfile:1.7
# Single-purpose multi-stage: build with node, serve with nginx.
# Modeled on the galina-admin-api caching pattern.

FROM node:26-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Layer 1: dependencies — cached unless package.json / lockfile changes.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-fe,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --prefer-offline

# Layer 2: build — runs on any code change. VITE_API_URL baked at build time.
COPY . .
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
# `build:fast` = vite/esbuild only, no tsc type-check — much faster image
# build. Types are enforced separately (pnpm typecheck / CI).
RUN pnpm build:fast

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
