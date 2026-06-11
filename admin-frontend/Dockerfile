# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-admin,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --prefer-offline

COPY . .
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
