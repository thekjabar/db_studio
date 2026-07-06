# DB Studio Agent — Browser Auto-Pair (loopback OAuth flow)

Extends AGENT_TUNNEL_PROTOCOL.md. Replaces manual `--token` copy-paste with a
"double-click → browser Allow → paired automatically" flow, like `gcloud auth
login` / GitHub CLI. Manual `--token` still works as a fallback.

## Servers / hosts (IMPORTANT — current production)

- Frontend app: `https://queryschema.com`
- API:          `https://api.queryschema.com`  (WS at `wss://api.queryschema.com/agent-ws`)
- The agent's compiled-in DEFAULT server must be `wss://api.queryschema.com`
  (the old `database-api.mrwari.com` default is WRONG — fix it).
- The agent's default APP (browser) base must be `https://queryschema.com`.

## The flow

1. User double-clicks `agent.exe` (no token, no saved creds).
2. Agent starts a local HTTP server on `127.0.0.1:<ephemeral port>` with ONE
   route: `GET /callback`. It generates a random `state` (32+ bytes, base64url).
3. Agent opens the user's browser to:
   `https://queryschema.com/agent/authorize?callback=http%3A%2F%2F127.0.0.1%3A<port>%2Fcallback&state=<state>&name=<hostname>`
   (also print this URL to the console as a fallback if the browser can't open.)
4. Browser loads the DB Studio SPA `/agent/authorize` page:
   - If the user is NOT logged in → normal login, then return to this page.
   - Shows: **"Allow the agent on '<name>' to connect to your databases?"**
     with an **Allow** and **Cancel** button. `name`/`callback`/`state` come
     from the query string.
   - On **Allow**: the SPA calls the API `POST /api/agents/authorize` with
     `{ name, state }` (JWT-authed as the logged-in user). The API:
       - creates (or reuses) an Agent owned by this user with that name,
       - mints a short-lived pairing token (JWT `{sub:userId, agentId, kind:'agent-pairing'}`),
       - returns `{ token, agentId, state }`.
   - The SPA then redirects the browser to the agent's loopback callback:
     `http://127.0.0.1:<port>/callback?token=<token>&state=<state>`
     (a top-level navigation / `window.location.assign`, NOT fetch — so it hits
     the agent's local server directly and avoids CORS).
5. Agent's `/callback` handler:
   - verifies `state` matches the one it generated (reject otherwise),
   - reads `token`, responds with a simple HTML success page
     ("Paired! You can close this tab and return to the agent."),
   - hands the token to the main flow.
6. Agent connects to `wss://api.queryschema.com/agent-ws?token=<token>` exactly
   as today, gets `ready` with `agentId`+`refreshSecret`, saves them, and starts
   tunneling. Subsequent runs use the saved refresh secret (no browser).

## Security

- `state` is a CSRF/nonce binding the browser round-trip to THIS agent process.
  The agent MUST reject a callback whose `state` doesn't match.
- Loopback only: the callback server binds `127.0.0.1` (never 0.0.0.0), random
  port, and shuts down immediately after receiving one valid callback (with a
  timeout, e.g. 5 min, after which it gives up and prints the manual `--token`
  hint).
- The pairing token stays short-lived (15 min) and single-user-scoped; the
  loopback token never leaves the machine except over localhost.
- The `/agent/authorize` page must show WHICH agent name is being authorized and
  require an explicit click — never auto-approve.

## Deliverables

- **Go agent (F1):** new `internal/pair/pair.go` — `BrowserPair(ctx, appBase) (token string, err error)`:
  starts loopback server, opens browser (use `rundll32 url.dll` / `cmd /c start`
  on Windows, `xdg-open` linux, `open` mac — or a small helper), waits for the
  callback, returns the token. Wire into main.go: when no token & no saved creds,
  call BrowserPair instead of exiting. Add `--no-browser` to fall back to
  printing the URL + waiting. Also FIX defaultServer -> wss://api.queryschema.com
  and add defaultAppBase = https://queryschema.com (+ `--app` flag).
- **Frontend (F2):** new route `/agent/authorize` rendering the Allow/Cancel
  page; reads callback/state/name from query; calls the new API; on success
  `window.location.assign(callback + '?token=...&state=...')`. Handle
  not-logged-in by bouncing through login and back.
- **Backend (F3):** `POST /api/agents/authorize` `{ name, state }` -> creates/reuses
  a user-owned Agent, returns `{ token, agentId, state }`. Reuse AgentsService's
  pairing-token minting.
