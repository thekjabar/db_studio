# DB Studio Frontend

React 19 + Vite 6 + Tailwind 4 + shadcn/ui dashboard for the DB Studio NestJS backend.

## Setup

```bash
cd frontend
pnpm install
cp .env.example .env
pnpm dev
```

Open http://localhost:5173. The backend must be running at `VITE_API_URL` (default `http://localhost:3000`).

## Env

- `VITE_API_URL` — base URL for the NestJS API.

## Auth

- Access token is stored in memory (zustand).
- Refresh token is an httpOnly cookie (`dbdash_rt`) — axios is configured with `withCredentials: true`.
- Axios interceptor auto-refreshes on 401.

## Routes

- `/login`, `/signup`
- `/connections` — connection list + create dialog
- `/c/:id/t/:schema/:table` — data + definition tabs
- `/c/:id/sql` — Monaco SQL editor
- `/c/:id/er` — xyflow ER diagram
- `/c/:id/schema` — schema editor with DDL preview
- `/c/:id/audit` — audit log

## Keyboard

- `Ctrl/Cmd+K` — command palette
- `Ctrl/Cmd+Enter` — run query in SQL editor
