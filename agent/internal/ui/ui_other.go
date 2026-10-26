//go:build !cgo || (!windows && !darwin)

// Package ui's no-window stub. The window is drawn by webview_go, which binds
// WebView2 on Windows and WebKit on macOS — both through cgo. So it exists only
// where a C toolchain was present at build time: Linux has no backend here at
// all, and a macOS binary CROSS-COMPILED from another OS is necessarily
// cgo-less (Apple's SDK isn't there to link against). This stub keeps the same
// exported API so main compiles everywhere, and Run returns an error so main
// falls back to the console reconnect loop — which tunnels exactly as well,
// just without a window.
package ui

import "errors"

// Status mirrors the Windows build's Status enum so main can reference it on any
// platform. The values are never displayed here (Run is a no-op stub).
type Status int

const (
	Connecting Status = iota
	Online
	Offline
	Pairing
)

// Run reports that the GUI window is unavailable on this platform so the caller
// falls back to the console loop. onReady/onQuit are never invoked.
func Run(onReady func(), onQuit func()) error {
	return errors.New("GUI window is only available on Windows in this build")
}

// SetStatus is a no-op on non-Windows platforms.
func SetStatus(s Status, detail string) {}

// SetIdentity is a no-op on non-Windows platforms.
func SetIdentity(name, server string) {}

// Quit is a no-op on non-Windows platforms.
func Quit() {}
