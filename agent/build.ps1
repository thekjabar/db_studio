# build.ps1 - cross-compile the DB Studio agent to a Windows amd64 exe.
#
# Usage (from the agent/ directory):
#   ./build.ps1
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

$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:CGO_ENABLED = "0"

& $go mod tidy
& $go vet ./...
& $go build -trimpath -ldflags "-s -w" -o agent.exe .

Write-Host "Built agent.exe:"
Get-Item agent.exe | Select-Object Name, Length, LastWriteTime
