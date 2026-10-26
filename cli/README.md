# Query Schema CLI

Run SQL against your connections from a terminal, a script, or CI.

## Install

Node 18+ is the only requirement. Download the single-file build and put it on
your PATH:

```bash
curl -fsSL https://api.queryschema.com/downloads/queryschema-cli.mjs -o /usr/local/bin/queryschema
chmod +x /usr/local/bin/queryschema
queryschema --help
```

Or run it from this repo:

```bash
cd cli && npm install && npm run bundle && node dist/queryschema-cli.mjs --help
```

## Authenticate

Create a key in Query Schema → **API keys**. A key can be scoped to specific
connections; an unscoped key reaches everything its owner can.

```bash
export QUERYSCHEMA_TOKEN=dbs_live_…
# or: ~/.queryschema/config.json  →  { "url": "...", "token": "dbs_live_…" }
```

The default URL is `https://queryschema.com/api/v1`; override with
`QUERYSCHEMA_URL` or `--url` for a self-hosted install.

## Use

```bash
# What can this key see?
queryschema connections ls

# Introspect
queryschema tables <connection-id> --schema public
queryschema tables schemas <connection-id>

# Run SQL
queryschema query <connection-id> --sql "SELECT count(*) FROM users"

# Parameters are BOUND, never pasted into the SQL
queryschema query <connection-id> \
  --sql "SELECT * FROM orders WHERE created_at >= :since AND status = :status" \
  --param since=2026-01-01 --param status=paid

# A file, as CSV, into a file
queryschema query <connection-id> --file report.sql --format csv > out.csv

# Writes need a role above VIEWER; destructive ones need to say so
queryschema query <connection-id> --sql "DELETE FROM sessions WHERE expired" --confirm-destructive
```

Row counts and timings go to stderr, so a redirect captures only data.

## Notes

* Rate limit: 120 requests per minute per key (HTTP 429 says how long to wait).
* A VIEWER key may only run SELECT; a read-only connection refuses writes.
* Column masking and row filters apply exactly as they do in the app — a key is
  never a way around them.
