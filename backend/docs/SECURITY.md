# Security hardening guide

This document covers the layers that defend user data when the application
database or server is compromised. Read in order — each layer assumes the
one above it.

## Threat model

We assume three failure modes:

| Scenario | What the attacker gets |
|---|---|
| **DB dump stolen** | The Postgres data directory or a `pg_dump` file. |
| **DB + server env stolen** | The above plus the API's environment variables (via RCE, env-file theft, etc). |
| **Live RCE on the API** | Running process memory, including whatever secrets the API has just unwrapped. |

The goal is to make scenarios 1 and 2 useless to the attacker and to
minimize the blast radius of scenario 3.

---

## Layer 1 — Application-level encryption (always on)

Every sensitive field is encrypted at rest with AES-256-GCM:

- `Connection.credentialsCt` — database host/user/password for every
  connection the user adds.
- `TotpSecret.secretCt` — 2FA seeds.
- `WorkspaceSso.clientSecretCt` — OIDC client secret.
- `Webhook.secretCt` — outbound HMAC signing key.

Plus these are hashed (never recoverable from a DB leak):

- `User.passwordHash` — argon2id.
- `ApiKey.tokenSha` + `ApiKey.tokenHash` — sha256 index + argon2 verify.
- `RefreshToken.tokenHash`, `EmailVerification.tokenSha`, `PasswordReset.tokenSha` — sha256.

Encryption format is versioned:

- `v2:<providerId>:<wrappedDek>:<payload>` — new records. Each gets a
  fresh random 256-bit Data Encryption Key (DEK) that's wrapped with the
  configured key provider (see Layer 2).
- legacy base64 — the original single-master-key format. Still readable
  forever for backward compatibility; no forced migration needed.

---

## Layer 2 — Choose a key provider (`KMS_PROVIDER`)

This is the single most important production configuration. It decides
where the master key — the one that unwraps every DEK — lives.

### `local` (default)

The master key is the `ENCRYPTION_KEY` env var. Good for self-host, dev,
single-tenant deployments.

**Risk**: if an attacker gets both the DB *and* the server environment,
they can decrypt everything.

### `aws` — AWS KMS

```env
KMS_PROVIDER=aws
AWS_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/abcd-...
AWS_REGION=us-east-1
```

Install the SDK: `pnpm add @aws-sdk/client-kms`.

Grant the API's IAM role `kms:Encrypt` + `kms:Decrypt` on the CMK. The
master key never leaves KMS. Stealing the env gives you a role ARN —
useless without the matching IAM principal bound to the instance.

Every `kms:Decrypt` call appears in CloudTrail, so you get an audit log
of every credential unwrap attempt — including failed ones.

### `gcp` — Google Cloud KMS

```env
KMS_PROVIDER=gcp
GCP_KMS_KEY_NAME=projects/P/locations/global/keyRings/dbdash/cryptoKeys/master
```

Install: `pnpm add google-auth-library`.

Uses Application Default Credentials — either the Workload Identity of
the running pod / VM, or `GOOGLE_APPLICATION_CREDENTIALS` pointing at a
service account JSON. Grant `roles/cloudkms.cryptoKeyEncrypterDecrypter`.

### `vault` — HashiCorp Vault Transit

```env
KMS_PROVIDER=vault
VAULT_ADDR=https://vault.example.com
VAULT_TOKEN=s.xxxxxxxx
VAULT_TRANSIT_KEY=dbdash
```

No SDK needed — uses the REST API. Set up Vault Transit:

```bash
vault secrets enable transit
vault write -f transit/keys/dbdash
# Policy grants encrypt + decrypt on transit/encrypt/dbdash + transit/decrypt/dbdash
```

For production prefer AppRole or Kubernetes auth over a static token,
with a token-renewal sidecar.

### Migrating from `local` to a KMS provider

Zero-downtime migration works because the reader accepts any registered
provider's format, not just the primary:

1. Set up the KMS (AWS CMK / GCP key / Vault transit key).
2. Grant the API role encrypt+decrypt permission.
3. Set `KMS_PROVIDER=aws` (or `gcp` / `vault`) alongside the existing
   `ENCRYPTION_KEY`. **Keep the old `ENCRYPTION_KEY` set** — the reader
   needs it to unwrap legacy (v1) records.
4. Deploy. From now on every **new** write goes to KMS.
5. Optional: run `scripts/re-encrypt-to-kms.ts` to backfill old rows into
   the new format. Safe to run while the API is live.
6. After backfill finishes, rotate the old `ENCRYPTION_KEY` out of the
   env (future v2-only records no longer reference it).

---

## Layer 3 — Encrypted backups

The `db-backup` container runs `pg_dump` nightly to the `app_backups`
volume. By default the output is plaintext `.sql.gz`.

**Enable encryption:**

1. Install [age](https://github.com/FiloSottile/age) locally.
2. Generate a keypair **off the server**:
   ```bash
   age-keygen -o backup-key.txt
   ```
   The file contains both the private key and a comment showing the
   public key ("recipient"). Example recipient:
   `age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p`
3. Copy **only the recipient** into `.env`:
   ```env
   BACKUP_AGE_RECIPIENT=age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
   ```
4. Store `backup-key.txt` **somewhere else** — password manager, vault,
   HSM, offline safe. Never on the same host as the API.
5. Restart: `docker compose restart db-backup`.
6. The next backup writes `.sql.gz.age`. Even if the volume is copied
   off-host, an attacker without the private key can't read it.

**Restore from an encrypted backup:**

```bash
age --decrypt --identity backup-key.txt dbdash-20260424T020000Z.sql.gz.age \
  | gunzip \
  | docker compose exec -T db psql -U dbdash -d dbdash
```

**Multiple recipients** (two-operator quorum): comma-separate:

```env
BACKUP_AGE_RECIPIENT=age1alice...,age1bob...
```

Either key can decrypt.

---

## Layer 4 — Volume / disk encryption

Application encryption protects *rows*. Volume encryption protects
everything else Postgres writes: WAL, tempfiles, stale pages. Without it,
an attacker who steals the raw volume image may recover deleted or
pre-encryption data.

### Cloud deployments

- **AWS**: enable EBS encryption (free, default on all new accounts
  since 2023). Set `"Encrypted": true` in the volume definition. Use a
  customer-managed CMK separate from the KMS one above.
- **GCP**: Persistent Disks are encrypted by default with Google-managed
  keys. Use a CMEK via Cloud KMS for stronger separation.
- **Azure**: enable Azure Disk Encryption.

### Self-hosted Linux

Use LUKS on the device Docker volumes live on:

```bash
cryptsetup luksFormat /dev/sdb
cryptsetup open /dev/sdb app-encrypted
mkfs.ext4 /dev/mapper/app-encrypted
mount /dev/mapper/app-encrypted /var/lib/docker/volumes
```

Unlock at boot with a key from a TPM, a remote unlock service (dracut
`rd.neednet=1`), or manual passphrase — *not* a keyfile on the same disk.

---

## Layer 5 — Client-held keys (optional, per-connection)

See [CLIENT_HELD_KEYS.md](CLIENT_HELD_KEYS.md). Users encrypt a
connection's credentials in the browser with a passphrase. The server
stores ciphertext only and can't decrypt without the passphrase being
supplied on every use. Best for highest-sensitivity connections; breaks
scheduled queries and webhooks for that connection.

---

## Operational checklist

| Item | Status |
|---|---|
| `KMS_PROVIDER` set to `aws` / `gcp` / `vault` (not `local`) | |
| `BACKUP_AGE_RECIPIENT` set and private key stored off-host | |
| Volume encryption enabled at OS / cloud level | |
| `.env` file mode `600`, not world-readable | |
| Separate `ENCRYPTION_KEY` (and KMS CMK) per environment (prod/staging) | |
| `POSTGRES_PASSWORD` rotated on staff departure | |
| HTTPS enforced (Caddy in front, or cloud LB with TLS termination) | |
| `COOKIE_SECURE=true` in production | |
| Sentry DSN set so decryption failures alert you | |
| Periodic restore test from an encrypted backup | |

---

## What we still trust

Even with all layers on, these remain assumptions:

- The **KMS provider** is not compromised. AWS KMS / GCP KMS are
  high-assurance services; Vault's security depends on how you run it.
- The **API process memory** is not scraped. Once the API unwraps a DEK
  to decrypt a credential, that plaintext exists briefly in RAM. An
  attacker with live RCE can read it. Mitigate via process isolation,
  minimal container surface, and prompt patching.
- The **restore key** (backup age private key, KMS CMK administrators)
  is held by trustworthy operators.

For each of those, the remediation is operational: least-privilege IAM,
short-lived access credentials, auditing, and not running as root.
