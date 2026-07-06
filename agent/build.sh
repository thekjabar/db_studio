#!/usr/bin/env bash
# build.sh - cross-compile the DB Studio agent for all release targets.
#
# Usage (from the agent/ directory):
#   ./build.sh
#
# Produces, under dist/:
#   agent-windows-amd64.exe   (Windows, GUI window app: NO extra console window)
#   agent-macos-amd64         (macOS Intel)
#   agent-macos-arm64         (macOS Apple Silicon)
#   agent-linux-amd64         (Linux, console/headless)
#
# The Windows binary is a REAL desktop window app (Fyne): double-clicking it
# opens a visible window that shows in the taskbar with its own icon. It is
# linked with -H=windowsgui so ONLY the Fyne window appears, never a separate
# black terminal.
#
# Fyne requires a per-platform C toolchain (CGO):
#   - Windows: MinGW-w64 (gcc). Auto-detected at $LOCALAPPDATA/mingw64/bin.
#   - macOS:   Cocoa backend (cgo) — build on a Mac / osxcross host only.
#   - Linux:   Fyne needs X11/GL dev libs + gcc (out of scope here), so the Linux
#              target is built pure-Go (CGO off) as a console/headless agent. The
#              GUI ui package is Windows-gated; on Linux main falls back to the
#              console reconnect loop automatically.

set -euo pipefail

GO="${GO:-go}"
if ! command -v "$GO" >/dev/null 2>&1; then
  if [ -x "${LOCALAPPDATA:-}/go-toolchain/go/bin/go.exe" ]; then
    GO="${LOCALAPPDATA}/go-toolchain/go/bin/go.exe"
  fi
fi

# Put the machine-local MinGW-w64 (gcc) on PATH for the Windows CGO/Fyne build.
if [ -x "${LOCALAPPDATA:-}/mingw64/bin/gcc.exe" ]; then
  PATH="${LOCALAPPDATA}/mingw64/bin:$PATH"
fi

echo "Using go: $GO"
"$GO" version
if command -v gcc >/dev/null 2>&1; then
  echo "Using gcc: $(command -v gcc)"
else
  echo "WARNING: gcc not found on PATH; the Windows Fyne build will fail." >&2
fi

mkdir -p dist

# Tidy against the Windows CGO config so the Fyne GUI package is included.
GOOS=windows GOARCH=amd64 CGO_ENABLED=1 CC=gcc "$GO" mod tidy

have_cc() { command -v clang >/dev/null 2>&1 || command -v cc >/dev/null 2>&1; }
have_gcc() { command -v gcc >/dev/null 2>&1; }

build_target() {
  local goos="$1" goarch="$2" out="$3" ldflags="$4" needs_cgo="$5"
  echo ""
  echo "=== building ${goos}/${goarch} -> dist/${out} ==="
  if [ "$needs_cgo" = "1" ] && [ "$goos" = "darwin" ] && ! have_cc; then
    echo "WARNING: skipping ${goos}/${goarch}: no C compiler (macOS Cocoa backend needs cgo; build on a Mac)." >&2
    return 0
  fi
  if [ "$needs_cgo" = "1" ] && [ "$goos" = "windows" ] && ! have_gcc; then
    echo "WARNING: skipping ${goos}/${goarch}: no gcc (Fyne needs MinGW-w64)." >&2
    return 0
  fi
  if [ "$needs_cgo" = "1" ]; then
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=1 CC=gcc "$GO" build -trimpath -ldflags "$ldflags" -o "dist/${out}" .
  else
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 "$GO" build -trimpath -ldflags "$ldflags" -o "dist/${out}" .
  fi
  ls -la "dist/${out}"
}

# Windows: Fyne GUI window app (cgo), GUI subsystem so no extra console window.
build_target windows amd64 agent-windows-amd64.exe "-H=windowsgui -s -w" 1
# macOS (cgo): only builds on a Mac / osxcross host.
build_target darwin  amd64 agent-macos-amd64        "-s -w" 1
build_target darwin  arm64 agent-macos-arm64        "-s -w" 1
# Linux: pure Go console/headless agent (GUI is Windows-gated).
build_target linux   amd64 agent-linux-amd64        "-s -w" 0

echo ""
echo "Build complete. Artifacts in dist/:"
ls -la dist/
