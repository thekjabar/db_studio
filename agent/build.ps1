# build.ps1 - cross-compile the Query Schema agent for all release targets.
#
# Usage (from the agent/ directory):
#   ./build.ps1
#
# Produces, under dist/:
#   agent-windows-amd64.exe   (Windows, GUI window app: NO extra console window)
#   agent-macos-amd64         (macOS Intel)
#   agent-macos-arm64         (macOS Apple Silicon)
#   agent-linux-amd64         (Linux, console/headless)
#
# The Windows binary is a REAL desktop window app (WebView2 / the Edge engine
# built into Windows 10+): double-clicking it opens a visible window that shows
# in the taskbar with the Query Schema icon. It is linked with -H=windowsgui so
# ONLY the app window appears — never a separate black terminal.
#
# Branding: resource_windows_amd64.syso carries the taskbar icon, the file
# Properties strings, and the DPI/UAC manifest. It is committed, so a plain
# `go build` picks it up. Regenerate it only after editing icon.ico /
# versioninfo.json / agent.manifest:
#
#   go run ./tools/genicon -o icon.ico
#   go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest `
#       -o resource_windows_amd64.syso versioninfo.json
#
# WebView2 (Windows) needs a C toolchain (CGO):
#   - Windows: MinGW-w64 (gcc). This script auto-detects the machine-local
#     install at %LOCALAPPDATA%\mingw64\bin and puts it on PATH.
#   - macOS: the WebKit backend (cgo) can ONLY be built on a Mac (see
#     build-mac.sh, which is meant to be run there).
#   - Linux: the GUI package is windows/darwin-gated, so the Linux target is
#     built pure-Go (CGO off) as a console/headless agent — main falls back to
#     the console reconnect loop automatically.
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

# Put the machine-local MinGW-w64 (gcc) on PATH for the Windows CGO/WebView2 build.
$mingwBin = Join-Path $env:LOCALAPPDATA "mingw64\bin"
if (Test-Path (Join-Path $mingwBin "gcc.exe")) {
    $env:PATH = "$mingwBin;$env:PATH"
}

Write-Host "Using go: $go"
& $go version
$gccPath = (Get-Command gcc -ErrorAction SilentlyContinue)
if ($gccPath) { Write-Host "Using gcc: $($gccPath.Source)" } else { Write-Warning "gcc not found on PATH; the Windows WebView2 build will fail." }

New-Item -ItemType Directory -Force -Path "dist" | Out-Null

# Tidy/vet the Windows configuration (CGO on) so the WebView2 GUI package is checked.
$env:GOOS = "windows"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "1"; $env:CC = "gcc"
& $go mod tidy

function Build-Target($goos, $goarch, $out, $ldflags, $needsCgo) {
    Write-Host ""
    Write-Host "=== building ${goos}/${goarch} -> dist/${out} ==="
    if ($needsCgo -and $goos -eq "darwin" -and -not (Get-Command "clang" -ErrorAction SilentlyContinue) -and -not (Get-Command "cc" -ErrorAction SilentlyContinue)) {
        Write-Warning "skipping ${goos}/${goarch}: no C compiler (macOS Cocoa backend needs cgo; build this target on a Mac)."
        return
    }
    if ($needsCgo -and $goos -eq "windows" -and -not (Get-Command "gcc" -ErrorAction SilentlyContinue)) {
        Write-Warning "skipping ${goos}/${goarch}: no gcc (WebView2 needs MinGW-w64; install it or set PATH)."
        return
    }
    $env:GOOS = $goos
    $env:GOARCH = $goarch
    if ($needsCgo) { $env:CGO_ENABLED = "1"; $env:CC = "gcc" } else { $env:CGO_ENABLED = "0" }
    & $go build -trimpath -ldflags $ldflags -o (Join-Path "dist" $out) .
    if (Test-Path (Join-Path "dist" $out)) {
        Get-Item (Join-Path "dist" $out) | Select-Object Name, Length, LastWriteTime
    }
}

# Windows: WebView2 GUI window app (cgo), GUI subsystem so no extra console window.
Build-Target "windows" "amd64" "agent-windows-amd64.exe" "-H=windowsgui -s -w" $true
# macOS (cgo): only builds on a Mac / osxcross host.
Build-Target "darwin"  "amd64" "agent-macos-amd64"        "-s -w" $true
Build-Target "darwin"  "arm64" "agent-macos-arm64"        "-s -w" $true
# Linux: pure Go console/headless agent (GUI is Windows-gated).
Build-Target "linux"   "amd64" "agent-linux-amd64"        "-s -w" $false

Write-Host ""
Write-Host "Build complete. Artifacts in dist/:"
Get-ChildItem "dist" | Select-Object Name, Length, LastWriteTime
