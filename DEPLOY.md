# Deploy reference for db_studio

## Local — push your changes

```bash
cd "D:\Database Connection"
git status
git add -A
git commit -m "your change message"
git push
```

## Server — pull and rebuild

SSH in:

```bash
ssh root@srv1649438
cd /var/www/db_studio
git pull
```

### Backend changes (api / Prisma schema / migrations)

```bash
cd /var/www/db_studio/backend
docker compose build api
docker compose up -d api
docker compose logs --tail=40 api
```

Migrations auto-run on startup (entrypoint runs `tsx prisma migrate deploy` first). Manual run if needed:

```bash
docker compose run --rm --entrypoint sh api -c \
  "node_modules/.bin/tsx node_modules/prisma/build/index.js migrate deploy"
```

### Customer frontend changes

```bash
cd /var/www/db_studio/frontend
docker compose build
docker compose up -d
```

### Admin frontend changes

```bash
cd /var/www/db_studio/admin-frontend
docker compose build
docker compose up -d
```

### Everything at once (after a multi-area pull)

```bash
cd /var/www/db_studio
git pull
cd backend && docker compose build api && docker compose up -d api && cd ..
cd frontend && docker compose build && docker compose up -d && cd ..
cd admin-frontend && docker compose build && docker compose up -d && cd ..
docker compose -f backend/docker-compose.yml ps
docker compose -f frontend/docker-compose.yml ps
docker compose -f admin-frontend/docker-compose.yml ps
```

## Verify after deploy

```bash
# All containers healthy?
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep dbdash

# API responding?
curl -sI http://127.0.0.1:3004/api/version 2>&1 | head -3

# Public URLs through Cloudflare?
curl -sI https://database-api.mrwari.com | grep -iE 'server|cf-ray|HTTP'
```

## Common gotchas

### 1. git pull blocked by local edits on server
```bash
git diff <file>          # see what's different
git checkout -- <file>   # discard if not needed
git pull
```

### 2. Backend build cache stuck (rare, after major dep changes)
```bash
cd /var/www/db_studio/backend
docker compose down api
docker image rm backend-api:latest
docker builder prune -af
docker compose build --no-cache --pull api
docker compose up -d api
```

### 3. Bad gateway after deploy — almost always the api container failing to start
```bash
docker compose logs --tail=80 api
```

### 4. Port reference
- `database.mrwari.com` → nginx :443 → host :8080 → frontend container
- `admin-database.mrwari.com` → nginx :443 → host :8081 → admin-frontend container
- `database-api.mrwari.com` → nginx :443 → host :3004 → api container :3000 internally

### 5. Where things live
- Source code: `/var/www/db_studio/{backend,frontend,admin-frontend}`
- `.env` files: each subdirectory has its own
- nginx vhosts: `/etc/nginx/sites-enabled/{database,admin-database,database-api}.conf`
- Letsencrypt certs: `/etc/letsencrypt/live/database-api.mrwari.com/`
- DB data volume: `docker volume backend_db_data`
- DB backups: `docker volume backend_app_backups`

## Rollback if a deploy breaks something

```bash
cd /var/www/db_studio
git log --oneline -5         # find the last good commit
git checkout <commit-sha>    # detached HEAD
# Then redo build/up for whichever stack you changed
# Once verified working, git checkout main again or fix forward
```
