# Dbdash Backend

Secure, multi-user dashboard API for connecting to and managing external databases (Postgres, MySQL, SQLite, MSSQL). Think "self-hosted Supabase Studio, but bring-your-own-database."

Built on NestJS 11 + Prisma 7.7 + Postgres 17.

## Stack

| Area | Choice |
|---|---|
| Framework | NestJS 11 (CommonJS build) |
| Language | TypeScript 5.7 strict mode |
| Package manager | pnpm 9 |
| App DB (users, connections, audit) | Postgres 17 via Prisma 7.7 |
| Target DB drivers | `pg`, `mysql2`, `better-sqlite3`, `tedious` |
| Auth | JWT (`@nestjs/jwt`), argon2id passwords, TOTP via `otplib` |
| Transport security | `helmet`, CORS lock, `@nestjs/throttler` |
| Secrets at rest | AES-256-GCM (Node `crypto`) with purpose-bound AAD |
| WebSockets | `@nestjs/websockets` + `socket.io`, Postgres `LISTEN/NOTIFY` |
| SQL classification | `node-sql-parser` |

## Quick start

```bash
cp .env.example .env
# generate a 32-byte base64 master key:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste the value into ENCRYPTION_KEY in .env
# set strong JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (>= 32 chars each)

pnpm install

# New in Prisma 7.7: `prisma bootstrap` replaces the old `prisma init` +
# `migrate dev --name init` dance. It reads `prisma.config.ts` (which wires
# `DATABASE_URL` into the datasource — Prisma 7 no longer accepts `url` inside
# `schema.prisma`), generates the client, and creates the initial migration in
# one step.
pnpm prisma bootstrap

pnpm start:dev
```

The server listens on `http://localhost:3000`, with all routes under `/api`
except `/health`.

### Prisma schema layout (Prisma 7 multi-file)

```
backend/
├── prisma.config.ts          # datasource URL + schema folder pointer
└── prisma/
    ├── schema.prisma         # generator + datasource (provider only)
    ├── enums/
    │   ├── role.prisma
    │   ├── dialect.prisma
    │   └── audit-action.prisma
    └── models/
        ├── user.prisma
        ├── refresh-token.prisma
        ├── totp-secret.prisma
        ├── connection.prisma
        ├── connection-member.prisma
        ├── audit-log.prisma
        └── saved-query.prisma
```

`prisma.config.ts` sets `schema: "prisma"` — the CLI recursively picks up every
`*.prisma` file in that folder. The main `schema.prisma` (the file with the
`datasource` block) must live at the root of the schema folder, and
`prisma/migrations/` must sit next to it.

## Environment

See [`.env.example`](./.env.example). Required:

- `DATABASE_URL` — Postgres 17 connection string for Dbdash's own DB.
- `ENCRYPTION_KEY` — 32 bytes, base64. The process refuses to start otherwise.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — each at least 32 chars.
- `FRONTEND_ORIGIN` — CORS allowlist (comma-separated).

## API surface

All routes prefixed with `/api` unless noted.

### Auth
- `POST /auth/signup` — `{ email, password, displayName? }` → `{ accessToken, userId }`; sets httpOnly refresh cookie.
- `POST /auth/login` — `{ email, password, totpCode? }` → same.
- `POST /auth/refresh` — rotates refresh cookie, returns new `accessToken`.
- `POST /auth/logout` — revokes current refresh token.
- `POST /auth/2fa/enable` — returns `{ otpauthUrl, qrDataUrl }`.
- `POST /auth/2fa/verify` — `{ code }`, enables TOTP after verifying.
- `POST /auth/2fa/disable` — `{ password, code }`.

### Connections
- `GET /connections` — list connections I own or am a member of.
- `POST /connections` — create.
- `GET /connections/:id`, `PATCH /connections/:id`, `DELETE /connections/:id`.
- `POST /connections/:id/test` — live connectivity check.

### Introspection (per connection, RBAC-guarded)
- `GET /connections/:id/schemas`
- `GET /connections/:id/tables?schema=`
- `GET /connections/:id/tables/:name/columns?schema=`
- `GET /connections/:id/tables/:name/data?schema=&limit=&offset=&orderBy=&filters=`
  - `orderBy`: `col:asc,col2:desc`
  - `filters`: JSON array of `{ column, op, value }`; `op` ∈ `=, !=, <, <=, >, >=, like, ilike, is null, is not null, in`.
- `POST /connections/:id/tables/:name/rows?schema=` body `{ values }`
- `PATCH /connections/:id/tables/:name/rows?schema=` body `{ pk, values }`
- `DELETE /connections/:id/tables/:name/rows?schema=` body `{ pk }`
- `GET /connections/:id/er?schema=` — nodes + edges for an ER diagram.
- `GET /connections/:id/functions`, `/triggers`, `/indexes`.

### SQL editor
- `POST /connections/:id/query` — `{ sql, params?, confirmDestructive? }`. Parses, classifies, and enforces.

### Schema editor (preview + confirm)
- `POST   /connections/:id/schema/tables` — create table. Without `confirm:true` returns `{ preview }`.
- `PATCH  /connections/:id/schema/tables` — alter (add/drop/rename/alter column, rename table).
- `DELETE /connections/:id/schema/tables?schema=&name=&confirm=true` — drop.

### Saved queries & audit
- `GET/POST /connections/:id/saved-queries`
- `DELETE /connections/:id/saved-queries/:queryId`
- `GET /connections/:id/audit?limit=&cursor=`

### WebSocket
Socket.IO namespace `/realtime`. Auth via `auth.token` (access JWT).
Events:
- `subscribe` → `{ connectionId, schema, table }`. Postgres uses `LISTEN` on
  channel `dbdash_<schema>_<table>` (you provide the trigger). Other dialects
  poll `COUNT(*)` every 5s.
- `unsubscribe` same payload.
- `change` pushed from server.

## Security model

- AES-256-GCM for connection creds + TOTP secret, master key from `ENCRYPTION_KEY`. AAD binds each ciphertext to a purpose string (`conn:<id>`, `totp:<userId>`), so ciphertexts can't be swapped.
- argon2id for password hashes. Failed-login includes a dummy verify to blunt timing attacks.
- Access JWT 15m; refresh token 7d, stored hashed (SHA-256), rotated on every `/refresh`, delivered as `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/auth`.
- Every target-DB endpoint: `JwtAuthGuard` → `RbacGuard` (OWNER > EDITOR > VIEWER) → driver.
- Identifiers are whitelisted against live introspection, then dialect-quoted. Values go through native parameterized queries.
- Per-session `statement_timeout` / `MAX_EXECUTION_TIME` / `requestTimeout`. Read-only mode wraps sessions in `SET TRANSACTION READ ONLY` (or dialect equivalent). `VIEWER` role always forces read-only regardless of connection setting.
- SQL editor uses `node-sql-parser` + keyword fallback. `DROP`, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`, and `ALTER` require `confirmDestructive: true`. Viewers are restricted to `SELECT`.
- `helmet`, CORS from env, throttling (100/min default; `/auth/login` limited to 10/min, `/auth/signup` to 5/min).
- Audit log has no update/delete routes; truncates `sqlText` at 10k chars.
- Global exception filter strips stack traces and internal error text before responding.
- `ValidationPipe` has `whitelist`, `forbidNonWhitelisted`, `transform: true` on every DTO.

## Docker

```bash
docker build -t dbdash-backend .
docker run --rm -p 3000:3000 --env-file .env dbdash-backend
```

Multi-stage build, non-root `node` user, `HEALTHCHECK` on `/health`.

## Scripts

```bash
pnpm start:dev      # watch mode
pnpm build          # tsc via nest build
pnpm start:prod     # node dist/main.js
pnpm prisma:bootstrap  # bootstrap + migrate
pnpm prisma:generate
pnpm test           # jest smoke
```

## What's implemented vs stubbed

| Area | Status |
|---|---|
| Auth (signup/login/refresh/logout/2FA) | Full |
| AES-256-GCM crypto with purpose binding | Full |
| RBAC (OWNER/EDITOR/VIEWER, owner-implicit) | Full |
| Audit log (append-only) | Full |
| Postgres driver | Full — pooled, `SET statement_timeout`, `SET TRANSACTION READ ONLY`, introspection (tables/cols/PK/UQ/FK/indexes/functions/triggers), ER, CRUD, DDL with preview |
| MySQL driver | Full surface — connect, introspect (via `information_schema` + `statistics`), CRUD, FK grouping, DDL with preview. Less exercised than Postgres. |
| SQLite driver | Full surface via `better-sqlite3` + `PRAGMA`. Functions list empty (sqlite has none). |
| MSSQL driver | Full surface via `tedious`. Uses fresh connection per call — simple but not the fastest. String-typed parameter values everywhere (review before running against real prod data). |
| SQL classifier | `node-sql-parser` with keyword fallback and multi-statement block |
| Realtime gateway | Postgres `LISTEN/NOTIFY` on `dbdash_<schema>_<table>` (user must install trigger); 5s polling fallback for others |
| Schema editor | Preview-then-confirm for all four dialects |
| Saved queries | CRUD (delete only by author) |
| Connection members endpoint | **Not exposed.** `ConnectionMember` table exists but no `POST /connections/:id/members` controller — add when you're ready for multi-user sharing UI. |
| Password reset / email verify | **Not included.** Add when you wire SMTP. |

## Review before production

1. **Run `pnpm install` first**: the listed versions are the latest on npm as of April 2026; verify compatibility, particularly `@prisma/client` 7.7 and `@nestjs/throttler` 6.
2. **Prisma 7.7 `prisma bootstrap`** is the new init command. If your installed Prisma CLI is older, fall back to `prisma init && prisma migrate dev --name init`.
3. **MSSQL driver** stringifies all parameter values (`TYPES.NVarChar`) — fine for most cases, but if you need native bigint/date typing, refine `insertRow`/`updateRow`/`deleteRow` to map column types → tedious `TYPES`.
4. **Realtime Postgres LISTEN** requires you to install a trigger on the target DB that `NOTIFY`s `dbdash_<schema>_<table>` on row changes. The gateway only subscribes; it doesn't provision the trigger.
5. **Rate limiting** uses an in-memory store via `@nestjs/throttler`'s default. For multi-instance deploys, configure a shared store (Redis).
6. **Refresh token rotation** always issues a fresh token and marks the old one revoked. There's no refresh-reuse detection-cascade (compromise detection). Add one if that's in your threat model.
7. **Error sanitization** — the global filter redacts stack traces, but database drivers can still throw messages containing SQL fragments. They propagate as the `message` field. Audit before exposing to untrusted clients.
8. **Cookie `SameSite=Strict`** means top-level navigations from your frontend origin won't carry the refresh cookie if the frontend is served from a different site. Change to `Lax` if you hit that.
9. **CSP / other helmet policies** use helmet defaults. Tune for your frontend (you'll likely need `connectSrc` allowances).
10. **Tests** are smoke-level (crypto round-trip, classifier edges). Harden with integration tests against real Postgres / MySQL containers before trusting destructive endpoints.
