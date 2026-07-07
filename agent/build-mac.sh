#!/usr/bin/env bash
# Build the DB Studio agent as a macOS app (WebKit window via webview_go).
# Run this ON A MAC. It installs Go if missing (via Homebrew) and produces the
# binaries in ./dist. No GitHub / CI / billing needed.
#
#   chmod +x build-mac.sh && ./build-mac.sh
#
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Checking for Go..."
if ! command -v go >/dev/null 2>&1; then
  echo "    Go not found. Installing via Homebrew..."
  if ! command -v brew >/dev/null 2>&1; then
    echo "    Homebrew not found. Install it first from https://brew.sh, then re-run."
    echo "    Or install Go manually from https://go.dev/dl/ (macOS pkg) and re-run."
    exit 1
  fi
  brew install go
fi
echo "    Go: $(go version)"

# webview_go uses WebKit via cgo; Xcode Command Line Tools provide the compiler.
if ! xcode-select -p >/dev/null 2>&1; then
  echo "==> Installing Xcode Command Line Tools (a dialog may pop up — accept it)..."
  xcode-select --install || true
  echo "    If a dialog appeared, finish it, then re-run this script."
fi

export CGO_ENABLED=1
mkdir -p dist

ARCH="$(uname -m)"  # arm64 (Apple Silicon) or x86_64 (Intel)
echo "==> Building for your Mac ($ARCH)..."
go mod download

# Build for this Mac's architecture (works on the machine you're building on).
if [ "$ARCH" = "arm64" ]; then
  GOARCH=arm64 go build -ldflags "-s -w" -o dist/agent-macos-arm64 .
  BUILT=dist/agent-macos-arm64
else
  GOARCH=amd64 go build -ldflags "-s -w" -o dist/agent-macos-amd64 .
  BUILT=dist/agent-macos-amd64
fi

# Also build the other arch so we can ship both (cross-arch build is fine on mac).
GOARCH=arm64 go build -ldflags "-s -w" -o dist/agent-macos-arm64 . 2>/dev/null || true
GOARCH=amd64 go build -ldflags "-s -w" -o dist/agent-macos-amd64 . 2>/dev/null || true

echo ""
echo "==> Done. Binaries in ./dist:"
ls -la dist/agent-macos-* 2>/dev/null || true
echo ""
echo "This Mac built: $BUILT"
echo "Run it:  ./$BUILT     (a window should open)"
echo ""
echo "Send the dist/agent-macos-arm64 and dist/agent-macos-amd64 files back so they"
echo "can be published on the download page."
