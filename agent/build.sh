#!/usr/bin/env bash
# build.sh - cross-compile the DB Studio agent for all release targets.
#
# Usage (from the agent/ directory):
#   ./build.sh
#
# Produces, under dist/:
#   agent-windows-amd64.exe   (Windows, GUI subsystem: NO console window)
#   agent-macos-amd64         (macOS Intel)
#   agent-macos-arm64         (macOS Apple Silicon)
#   agent-linux-amd64         (Linux)
#
# The agent is a system-tray app. The Windows binary is linked with
# -H=windowsgui so double-clicking it shows only the tray icon, never a black
# terminal window.
#
# NOTE: the macOS tray backend is Objective-C (cgo, -framework Cocoa), so the two
# macOS targets can ONLY be built on a Mac (or with an osxcross toolchain +
# CGO_ENABLED=1). On hosts without a C compiler those two builds are skipped with
# a warning; Windows and Linux build with CGO disabled (pure Go).

set -euo pipefail

GO="${GO:-go}"
if ! command -v "$GO" >/dev/null 2>&1; then
  if [ -x "${LOCALAPPDATA:-}/go-toolchain/go/bin/go.exe" ]; then
    GO="${LOCALAPPDATA}/go-toolchain/go/bin/go.exe"
  fi
fi

echo "Using go: $GO"
"$GO" version

mkdir -p dist

export CGO_ENABLED=0
"$GO" mod tidy
"$GO" vet ./...

have_cc() { command -v clang >/dev/null 2>&1 || command -v cc >/dev/null 2>&1; }

build_target() {
  local goos="$1" goarch="$2" out="$3" ldflags="$4" needs_cgo="$5"
  echo ""
  echo "=== building ${goos}/${goarch} -> dist/${out} ==="
  if [ "$needs_cgo" = "1" ] && ! have_cc; then
    echo "WARNING: skipping ${goos}/${goarch}: no C compiler (macOS tray backend needs cgo; build on a Mac)." >&2
    return 0
  fi
  if [ "$needs_cgo" = "1" ]; then
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=1 "$GO" build -trimpath -ldflags "$ldflags" -o "dist/${out}" .
  else
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 "$GO" build -trimpath -ldflags "$ldflags" -o "dist/${out}" .
  fi
  ls -la "dist/${out}"
}

# Windows: GUI subsystem so no console window appears.
build_target windows amd64 agent-windows-amd64.exe "-H=windowsgui -s -w" 0
# macOS (cgo): only builds on a Mac / osxcross host.
build_target darwin  amd64 agent-macos-amd64        "-s -w" 1
build_target darwin  arm64 agent-macos-arm64        "-s -w" 1
# Linux: pure Go.
build_target linux   amd64 agent-linux-amd64        "-s -w" 0

echo ""
echo "Build complete. Artifacts in dist/:"
ls -la dist/
