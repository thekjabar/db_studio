# build.ps1 - cross-compile the DB Studio agent for all release targets.
#
# Usage (from the agent/ directory):
#   ./build.ps1
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
# NOTE: the macOS tray backend is Objective-C (cgo, -framework Cocoa), so the
# two macOS targets can ONLY be built on a Mac (or with an osxcross toolchain +
# CGO_ENABLED=1). On Windows/Linux hosts those two builds are skipped with a
# warning; Windows and Linux build with CGO disabled (pure Go).
#
# Honors an existing GOROOT if set, otherwise falls back to the known
# machine-local toolchain install.

$ErrorActionPreference = "Stop"

if (-not $env:GOROOT -or -not (Test-Path (Join-Path $env:GOROOT "bin\go.exe"))) {
    $candidate = Join-Path $env:LOCALAPPDATA "go-toolchain\go"
    if (Test-Path (Join-Path $candidate "bin\go.exe")) {
        $env:GOROOT = $candidate
    }
}

$go = "go"
if ($env:GOROOT -and (Test-Path (Join-Path $env:GOROOT "bin\go.exe"))) {
    $go = Join-Path $env:GOROOT "bin\go.exe"
}

Write-Host "Using go: $go"
& $go version

New-Item -ItemType Directory -Force -Path "dist" | Out-Null

$env:CGO_ENABLED = "0"
& $go mod tidy
& $go vet ./...

function Build-Target($goos, $goarch, $out, $ldflags, $needsCgo) {
    Write-Host ""
    Write-Host "=== building ${goos}/${goarch} -> dist/${out} ==="
    if ($needsCgo -and -not (Get-Command "clang" -ErrorAction SilentlyContinue) -and -not (Get-Command "cc" -ErrorAction SilentlyContinue)) {
        Write-Warning "skipping ${goos}/${goarch}: no C compiler (macOS tray backend needs cgo; build this target on a Mac)."
        return
    }
    $env:GOOS = $goos
    $env:GOARCH = $goarch
    if ($needsCgo) { $env:CGO_ENABLED = "1" } else { $env:CGO_ENABLED = "0" }
    & $go build -trimpath -ldflags $ldflags -o (Join-Path "dist" $out) .
    if (Test-Path (Join-Path "dist" $out)) {
        Get-Item (Join-Path "dist" $out) | Select-Object Name, Length, LastWriteTime
    }
}

# Windows: GUI subsystem so no console window appears.
Build-Target "windows" "amd64" "agent-windows-amd64.exe" "-H=windowsgui -s -w" $false
# macOS (cgo): only builds on a Mac / osxcross host.
Build-Target "darwin"  "amd64" "agent-macos-amd64"        "-s -w" $true
Build-Target "darwin"  "arm64" "agent-macos-arm64"        "-s -w" $true
# Linux: pure Go.
Build-Target "linux"   "amd64" "agent-linux-amd64"        "-s -w" $false

Write-Host ""
Write-Host "Build complete. Artifacts in dist/:"
Get-ChildItem "dist" | Select-Object Name, Length, LastWriteTime
