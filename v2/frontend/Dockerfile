# v1's exact frontend, built with Bun, served under /v2, pointed at /v2/api.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
# Baked into the bundle: same-origin API under /v2/api (nginx proxies it).
ENV VITE_API_URL=/v2/api
RUN bun run build:fast

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html/v2
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
