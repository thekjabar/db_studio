# Secrets & rotation

This app holds three secrets you need to think about beyond "don't commit them":

| Env var | What breaks if leaked | What breaks if rotated |
|---|---|---|
| `ENCRYPTION_KEY` | **Every stored connection password.** The app encrypts each connection's credentials at rest with AES-256-GCM, keyed by this value (plus a purpose tag per connection). A leak lets the attacker decrypt every `credentialsCt` row they've scraped. | Every stored connection becomes unreadable until re-encrypted. |
| `JWT_ACCESS_SECRET` | Attackers can forge access tokens for any user. Short-lived (15 min default), so the blast radius is narrow. | All active access tokens stop working; users refresh silently and keep going. |
| `JWT_REFRESH_SECRET` | Attackers can forge refresh tokens and keep sessions alive indefinitely. | All users are logged out — their refresh tokens stop validating; they must sign in again. |

Plus:

- `POSTGRES_PASSWORD` — only the app talks to the DB, so rotation is straightforward.
- `SMTP_URL` / `SMTP_FROM` / `ANTHROPIC_API_KEY` / OAuth secrets — external credentials; rotate at the provider, copy new value into `.env`, redeploy.

---

## When to rotate

- **Immediately** if:
  - A laptop / server that had `.env` is lost, stolen, or sold.
  - A dev leaves the team.
  - You committed a secret by accident (yes, even if you `git rebase -i` removed it — assume scrapers saw it).
- **Quarterly** as hygiene, especially `ENCRYPTION_KEY` since its blast radius is largest.

---

## `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`

Cheap to rotate.

1. Generate new values:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
   ```
2. Update `backend/.env`.
3. Restart the API:
   ```bash
   docker compose restart api
   ```
4. All users are logged out on their next refresh attempt. Expected.

---

## `POSTGRES_PASSWORD`

1. Exec into the db container and change the password:
   ```bash
   docker compose exec db psql -U dbdash -d dbdash \
     -c "ALTER USER dbdash WITH PASSWORD 'new-password-here';"
   ```
2. Update `POSTGRES_PASSWORD` in `.env` and also `DATABASE_URL` anywhere it's hardcoded.
3. Restart the API:
   ```bash
   docker compose up -d --force-recreate api
   ```
4. The `db-backup` service reads `POSTGRES_PASSWORD` too — it'll pick up on next cron tick, or restart it explicitly.

---

## `ENCRYPTION_KEY` — the hard one

**This is a two-phase rotation** because every `Connection` row has a `credentialsCt` encrypted under the old key. If you just swap keys, every existing connection becomes undecryptable and broken.

### Option A — "nuke and re-enter" (fastest, safe for small teams)

1. Tell users their connections will need re-entry.
2. Generate new key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
3. Swap `ENCRYPTION_KEY` in `.env`, restart API.
4. Delete all connections from the DB:
   ```bash
   docker compose exec db psql -U dbdash -d dbdash \
     -c "DELETE FROM \"Connection\";"
   ```
5. Users re-add their connections via the UI. New credentials encrypt under the new key.

Acceptable when you have < 10 connections and an evening free.

### Option B — re-encrypt in place (zero downtime, more work)

1. Generate new key.
2. Write a one-shot migration script that iterates every row in these tables:
   - `Connection.credentialsCt`
   - `Webhook.secretCt`
   - `TotpSecret.secretCt`
   - any `ScheduledQuery.sqlText` — not encrypted, no action
   - `ApiKey.tokenHash` — argon2, not recoverable from old key, no action

   For each row: decrypt with **old** key + original purpose tag, re-encrypt with **new** key + same purpose tag, update the row.
3. Run the script (one-shot, not a feature users invoke) against the DB while the API is **down or read-only**, so there's no write race.
4. Swap `ENCRYPTION_KEY` in `.env`, bring API back up.

A template for the migration script lives at `backend/scripts/rotate-encryption-key.ts` — copy it, set the old+new keys as env vars, run with `pnpm ts-node`. Back up the DB before running (you already have `db-backup` doing nightlies; confirm a fresh one exists).

### Option C — dual-key with grace period

If you need zero disruption, support both keys briefly:

1. Add `ENCRYPTION_KEY_OLD` alongside the new `ENCRYPTION_KEY` in `.env`.
2. Patch `CryptoService.decrypt` to try `ENCRYPTION_KEY` first, fall back to `ENCRYPTION_KEY_OLD`. (Small code change, no migration needed up-front.)
3. Deploy.
4. Run a background job that re-encrypts any row accessed with the old key on the fly.
5. When background re-encryption finishes, remove `ENCRYPTION_KEY_OLD` and the fallback.

Only worth the complexity if you have a hosted deployment with customers and can't schedule a 15-min window.

---

## General principles

- **Never commit secrets.** `.env` is gitignored — verify with `git check-ignore -v backend/.env`.
- **Keep `.env` file permissions tight.** On Linux: `chmod 600 .env`.
- **Separate environments have separate secrets.** Prod, staging, and dev must never share `ENCRYPTION_KEY` — a leak in staging shouldn't compromise prod connections.
- **Audit `.env` reads.** Nothing in the app should log `ENCRYPTION_KEY` or any secret. The `HttpExceptionFilter` sanitizes responses; the logger never prints env values directly.
- **Backup before rotating.** `docker compose run --rm db-backup /usr/local/bin/do-backup.sh` forces a backup immediately — confirm there's a fresh `*.sql.gz` in `app_backups` before running Option B or C.
