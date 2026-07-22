# Query Schema v2 — Rust + React (Bun) performance rebuild

A ground-up reimplementation of the Query Schema hot path in **Rust (axum + sqlx + tokio)**
with a **React + Vite frontend built by Bun**, served at **`queryschema.com/v2`**, talking to
the **same production Postgres** as v1. The point is a head-to-head performance comparison
against the current **NestJS (Node) + React (Node/pnpm)** stack.

This is **phase 1**: the endpoints that are actually slow in v1 — auth, connection listing,
schema introspection, **table-row browsing**, and **SQL execution**. It is structured so the
rest of v1's surface can be ported incrementally.

## Why these endpoints

The lag you see is on the data screens: opening a table (introspect + fetch rows) and running
SQL. Those exercise the full request → DB → serialize → response path, which is exactly where
framework + driver overhead shows up. Everything here returns a server-measured `tookMs` so the
two stacks can be compared apples-to-apples.

## Stack

| Layer     | v1 (current)             | v2 (this)                                  |
|-----------|--------------------------|--------------------------------------------|
| Backend   | NestJS 11 / Node / Prisma| **Rust / axum 0.7 / sqlx 0.7 / tokio**     |
| Frontend  | React 19 / Vite / pnpm   | **React 19 / Vite 5 / Bun**                |
| DB        | Postgres (shared)        | **same Postgres** (`DATABASE_URL`)         |
| Auth      | JWT access + rotating RT | JWT access (HS256), argon2 verify          |
| Passwords | argon2id (`$argon2id$…`) | **argon2id — same hashes, verified in Rust** |

v2 reads the **same `User` table** and verifies the same argon2id hashes, so any existing
account logs into v2 unchanged. It issues its **own** short-lived access JWT (`V2_JWT_SECRET`),
independent of v1's refresh-token rotation, so nothing in the shared DB is mutated by the test.

## Design derived from v1

- **DB models** (`backend/prisma/models/*`): `User(id cuid, email, passwordHash, displayName, …)`,
  `Connection(id, name, dialect, credentialsCt, ownerId, workspaceId, …)`, `RefreshToken(...)`.
  Prisma maps model → PascalCase table, fields → camelCase columns (both quoted), e.g. `"User"."passwordHash"`.
- **Connection credentials** are envelope-encrypted (AES-256-GCM + wrapped DEK, `crypto.service.ts`).
  Decrypting *user-added* connections requires replicating that envelope — **deferred to phase 2**.
  Phase 1 benchmarks against the **app's own Postgres** (the `public` schema you were browsing),
  which needs no crypto.

## API surface (phase 1)

All under `/v2/api` (nginx strips `/v2`). Auth = `Authorization: Bearer <accessToken>`.

| Method | Path                                   | Notes                                              |
|--------|----------------------------------------|----------------------------------------------------|
| GET    | `/health`                              | liveness                                           |
| GET    | `/api/health/db`                       | `SELECT 1` round-trip, returns `tookMs`            |
| POST   | `/api/auth/login`                      | `{email,password}` → `{accessToken, user}`         |
| GET    | `/api/auth/me`                         | current user                                       |
| GET    | `/api/connections`                     | connections owned by the user                      |
| GET    | `/api/introspect/schemas`              | non-system schemas                                 |
| GET    | `/api/introspect/:schema/tables`       | tables in a schema                                 |
| GET    | `/api/introspect/:schema/:table/columns`| columns + PK flags                                |
| GET    | `/api/table/:schema/:table/rows?limit&offset` | paginated rows (`to_jsonb`), `tookMs`       |
| POST   | `/api/query/run`                       | `{sql}` → `{columns, rows, tookMs, rowCount}`      |

**Row serialization trick:** arbitrary result sets are returned via
`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]') FROM (<query>) t`, so any column type maps to JSON
without per-OID decoding — one buffered round-trip, capped by `LIMIT`.

## Hosting (`queryschema.com/v2`)

- `docker-compose.yml` runs `qs-v2-api` (Rust) on an internal port and `qs-v2-web` (nginx serving
  the Bun-built static bundle).
- `deploy/nginx-v2.conf` adds `location /v2/` → the web container and `location /v2/api/` → the api
  container, to the existing host/frontend nginx. `/v2/api/` is rewritten to `/api/` upstream.

## Build & deploy notes (important)

- **No local Rust toolchain**, and the 4 GB prod box must not run an unconstrained Rust compile
  (OOM). Build the api image with low parallelism + swap: `DOCKER_BUILDKIT=1 docker build
  --build-arg CARGO_BUILD_JOBS=1 …`, or build on a bigger machine and `docker save | docker load`.
- Frontend: `cd v2/frontend && bun install && bun run build` → static `dist/` served by nginx.
- sqlx uses the **runtime** query API (no `query!` macro), so the backend compiles **without** a
  live database connection.

## Phase 2+ (not yet built)

Encrypted target-DB connections (replicate the AES-GCM envelope), realtime (websockets),
saved queries, dashboards/notebooks, RBAC/permissions, billing. The v1 surface is 59 controllers;
this ports the performance-critical core first.
