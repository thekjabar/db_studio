# Build the React app with Bun, serve the static bundle with nginx.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
RUN bun run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html/v2
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
