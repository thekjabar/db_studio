# Query Schema Local Agent

`dbstudio-agent` (built as `agent.exe` on Windows) is a tiny outbound-only
tunnel that lets **Query Schema** reach databases that are firewalled to your own
network/WiFi. The agent runs on your laptop, connects **out** to the Query Schema
server over secure WebSocket, and acts as a raw TCP byte-pipe. It never parses
SQL and never sees your database credentials — it only moves bytes between the
server and the `host:port` the server asks it to reach.

See `../AGENT_TUNNEL_PROTOCOL.md` for the full wire contract.

## How it works

1. In Query Schema, enable **Connect via local agent** on a connection and copy the
   short-lived **pairing token** it shows you.
2. Run the agent once with that token. It connects to
   `wss://<server>/agent-ws?token=<token>`, sends a `hello`, and the server
   replies `ready` with a long-lived `agentId` + `refreshSecret`.
3. The agent saves those credentials to its config file, so from then on it
   reconnects automatically **without** needing a new pairing token.
4. When the server needs the database, it tells the agent to `open` a TCP
   connection to `host:port`; the agent dials it (from your network) and pipes
   bytes both ways. Many connections are multiplexed over the one WebSocket.

## Running

First run (pairing):

```powershell
.\agent.exe --token <PAIRING_TOKEN>
```

Point at a non-default server (dev/local or self-hosted):

```powershell
.\agent.exe --token <PAIRING_TOKEN> --server ws://localhost:3000
.\agent.exe --token <PAIRING_TOKEN> --server wss://database-api.mrwari.com
```

After pairing, just run it with no token — it uses the saved refresh secret:

```powershell
.\agent.exe
```

The agent runs in the foreground and reconnects on its own (exponential backoff,
1s..30s). Press **Ctrl+C** to stop it cleanly.

### Flags

| Flag        | Description                                                                 |
|-------------|-----------------------------------------------------------------------------|
| `--token`   | Pairing token from the Query Schema UI. Needed only on first run or to re-pair. |
| `--server`  | Server base URL. Accepts `ws://`, `wss://`, `http://`, `https://`, or a bare host. Default `wss://database-api.mrwari.com`. Overrides the saved value. |
| `--config`  | Path to a config directory or a `config.json` file. Default is the OS user config dir (see below). |
| `--version` | Print version and exit.                                                     |

## Config file

Credentials and the server URL are stored in `config.json`:

- **Windows:** `%APPDATA%\dbstudio-agent\config.json`
- **Linux/macOS:** `$XDG_CONFIG_HOME/dbstudio-agent/config.json`
  (falls back to `~/.config/dbstudio-agent/config.json`)

```json
{
  "serverURL": "wss://database-api.mrwari.com",
  "agentId": "clx...",
  "refreshSecret": "..."
}
```

The file holds the long-lived refresh secret, so it is written with
owner-only permissions (`0600`) on unix. Delete it to force a fresh pairing.

## Building

The repo already ships a prebuilt `agent.exe`. To rebuild:

```powershell
# Windows PowerShell
.\build.ps1
```

```bash
# bash (Git Bash / WSL / Linux / macOS)
./build.sh
```

Both scripts cross-compile a Windows amd64 `agent.exe` by default. To build for
another OS with `build.sh`:

```bash
GOOS=linux  GOARCH=amd64 ./build.sh   # -> ./agent
GOOS=darwin GOARCH=arm64 ./build.sh   # -> ./agent
```

Manual build:

```bash
go mod tidy
GOOS=windows GOARCH=amd64 go build -o agent.exe .
```

Requirements: Go 1.23+. The only third-party dependency is
[`github.com/gorilla/websocket`](https://github.com/gorilla/websocket);
everything else is the Go standard library.

## Project layout

```
agent/
  main.go                     entry point: flags, config, reconnect loop
  internal/
    config/config.go          load/save config.json (per-OS location)
    tunnel/client.go          WS client, stream multiplexing, TCP dialing
  build.ps1 / build.sh        cross-compile helpers
  go.mod                      module dbstudio-agent
```

