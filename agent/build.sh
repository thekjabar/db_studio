#!/usr/bin/env bash
# build.sh - cross-compile the DB Studio agent to a Windows amd64 exe.
#
# Usage (from the agent/ directory):
#   ./build.sh
#
# Override GOOS/GOARCH in the environment to build for other targets, e.g.:
#   GOOS=linux GOARCH=amd64 ./build.sh   # produces agent (no .exe)

set -euo pipefail

GO="${GO:-go}"
if ! command -v "$GO" >/dev/null 2>&1; then
  if [ -x "${LOCALAPPDATA:-}/go-toolchain/go/bin/go.exe" ]; then
    GO="${LOCALAPPDATA}/go-toolchain/go/bin/go.exe"
  fi
fi

echo "Using go: $GO"
"$GO" version

export GOOS="${GOOS:-windows}"
export GOARCH="${GOARCH:-amd64}"
export CGO_ENABLED=0

OUT="agent"
if [ "$GOOS" = "windows" ]; then
  OUT="agent.exe"
fi

"$GO" mod tidy
"$GO" vet ./...
"$GO" build -trimpath -ldflags "-s -w" -o "$OUT" .

echo "Built $OUT:"
ls -la "$OUT"
