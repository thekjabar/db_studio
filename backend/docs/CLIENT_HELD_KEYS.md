# Client-held keys (experimental)

**Status: foundation in place, UI not wired up.** The schema and protocol
are defined below; the UI (passphrase prompt, key caching, session
management) is a follow-on.

Client-held keys give one extra guarantee over Layer 1–4 encryption: the
server **cannot decrypt the credential on its own**. The decryption key is
derived from a user passphrase and only exists in the browser. Even a
live attacker with RCE on the API server cannot read a client-held
connection's password — they can only read it during the brief window
when a user is actively running a query, and only for that one user's
session.

## Tradeoffs you accept

- **Every use requires a passphrase unlock.** Either re-entered on each
  request, or cached in `sessionStorage` with a timeout.
- **Lost passphrase = lost connection.** There is no server-side recovery;
  the user re-creates the connection from scratch. This is a feature, not
  a bug — recovery would require an escrow that defeats the point.
- **Scheduled queries don't work.** No user is present to unlock the key
  when cron fires.
- **Webhooks don't work.** Same reason.
- **Realtime subscriptions don't work** unless the user keeps the tab
  open and the session-cached key alive.

Use this for your most sensitive connections (prod write user, PII-heavy
schemas). Keep scheduled / automated connections on standard encryption.

## Protocol

### Connection creation

1. User toggles **Client-held encryption** in the Add Connection dialog.
2. UI generates a random 16-byte salt. Prompts for a passphrase (min 12 chars,
   user re-confirms).
3. UI derives a 32-byte key with Argon2id (t=3, m=64MiB, p=4) over
   `passphrase || salt`. (Library: `@noble/hashes/argon2`.)
4. UI encrypts the credentials JSON with AES-256-GCM, random IV:
   ```
   payload = iv(12) | tag(16) | ciphertext
   ```
5. POST `/connections` with `clientHeldKey: true`, `clientKeyKdfSalt: <base64>`,
   and `credentialsCt: <base64(payload)>`. The server stores these as-is.

### Connection use

1. UI prompts for passphrase (or uses cached key from sessionStorage).
2. Derives key from `(passphrase, salt-from-server)`.
3. Decrypts `credentialsCt` locally into the credentials JSON.
4. POSTs the decrypted credentials to `/connections/:id/query` as
   `_clientCreds: { host, user, password, ... }` over TLS. Server uses the
   creds to open a one-shot driver for this request, then discards.

The server's in-memory pool for client-held connections is *per request*
— it can't reuse a cached driver because the credentials only exist
during the request lifetime.

## Server changes needed (not yet implemented)

1. Extend `ConnectionsService.buildDriver()` to accept optional inline
   `creds` from the request body. If the connection has
   `clientHeldKey=true`, refuse to build a driver without inline creds —
   otherwise the server-stored ciphertext is useless to us.
2. Extend `RunQueryDto` (and similar DTOs) with an optional
   `_clientCreds` field. Validate its shape in the DTO class — do not log.
3. In the `HttpExceptionFilter`, explicitly redact `_clientCreds` from
   Sentry payloads.
4. Return `409 Client-Held` from `/schedules` and `/webhooks` endpoints
   when the target connection has `clientHeldKey=true`.

## UI changes needed (not yet implemented)

1. **Unlock modal**: a reusable modal that asks for the passphrase,
   derives the key, caches it in a zustand store (`client-key-store.ts`)
   keyed by connection id, with a configurable TTL (default 15 min,
   sliding window on use).
2. **Add Connection toggle + passphrase fields** with a non-dismissable
   "you cannot recover this passphrase" warning.
3. **Run button behaviour** on the SQL editor: if the selected
   connection has `clientHeldKey=true` and no cached key, show the
   unlock modal first.
4. **Connection list indicator**: a small lock icon showing which
   connections are client-held.

## Security properties

| Attack | Result |
|---|---|
| DB dump stolen | `credentialsCt` is AES-GCM ciphertext under a key derived from a passphrase the DB never saw. Attacker must crack Argon2id — memory-hard KDF, infeasible for strong passphrases. |
| DB + server env stolen | Same as above. Server-side `ENCRYPTION_KEY` / KMS is unused for these rows. |
| Live API RCE | Attacker can capture `_clientCreds` from the next request the victim sends. Limited to what the victim actually uses during the attack window — no passive harvesting of all connections. |
| User's laptop compromised while unlocked | Attacker reads the session-cached key from memory. Same risk as any browser-stored secret; mitigate with short TTL and require re-unlock for destructive statements. |

## When NOT to use client-held keys

- Connections used by scheduled queries or webhooks — pick standard
  encryption instead.
- Users who'll forget the passphrase and then blame you for lost access.
- Single-user self-host where the user's laptop already has the DB
  password in 1Password — no threat model gain.

---

Build the UI whenever you're ready. The schema is in place; the foundation
won't rot while you wait.
