# syntax=docker/dockerfile:1.7
# ---- Base ----
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /app

# ---- Deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm-fe,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile=false

# ---- Builder ----
FROM deps AS builder
COPY . .
# VITE_API_URL is read at build time and baked into the bundle. Default to
# the reverse-proxied /api path so the compiled assets work behind nginx
# without extra config. Override at build time if you host the API on a
# different origin.
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm build

# ---- Runner ----
FROM nginx:1.27-alpine AS runner
# Non-root nginx for defense in depth.
RUN adduser -D -H -u 1001 app && chown -R app:app /var/cache/nginx /var/log/nginx
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
