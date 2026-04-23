# DB Studio desktop (Tauri)

Wraps the Vite frontend in a native window via Tauri 2.

## Build once

1. Install the Rust toolchain: <https://rustup.rs>
2. From `frontend/` run:
   ```bash
   pnpm install
   pnpm tauri:dev    # hot-reload dev window
   pnpm tauri:build  # platform installer in src-tauri/target/release/bundle
   ```

## What's here

- `tauri.conf.json` — window size, product identifier, frontend dist dir.
- `Cargo.toml` + `src/*.rs` — minimal Rust entry. No custom IPC — the app
  talks to the same `/api` backend the web version does.
- `icons/` — **not committed**. Add PNGs/ICO/ICNS named as declared in
  `tauri.conf.json` before `pnpm tauri:build` or it'll fail at bundle time.

## Explicit non-goals (for now)

- Code signing (Authenticode / Apple notarization) — required for
  gatekeeper-free installs; do this in CI when you're ready to distribute.
- Auto-updater — Tauri has `tauri-plugin-updater`; set it up when you have
  a release pipeline posting signed bundles somewhere.
- Custom native IPC — everything still goes over HTTP to the backend. Add
  `#[tauri::command]` handlers in `src/lib.rs` if you ever need
  filesystem/OS access that the browser sandbox blocks.
