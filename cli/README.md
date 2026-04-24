# DB Studio CLI

Command-line interface for DB Studio. Handy for scripting, CI, and
sh-one-liners.

## Install

```bash
# From this repo:
cd cli
pnpm install
pnpm build
pnpm link --global
dbstudio --help
```

## Config

Set via env, flags, or `~/.dbstudio/config.json`:

```json
{
  "url": "https://studio.example.com/api",
  "token": "dbs_live_abc..."
}
```

Generate an API key in the UI → API keys, then save the token here.

## Examples

```bash
# List connections
dbstudio connections ls

# Run SQL
dbstudio query <connection-id> --sql "SELECT count(*) FROM users"

# Run a .sql file, output as CSV
dbstudio query <connection-id> --file report.sql --format csv > out.csv

# List schedules
dbstudio schedules ls

# Fire a schedule now
dbstudio schedules run <schedule-id>
```

## Output formats

- `--format table` (default) — fixed-width columns
- `--format json` — full API response
- `--format csv` — RFC 4180 CSV
