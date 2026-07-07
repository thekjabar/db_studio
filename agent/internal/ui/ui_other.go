//go:build !windows && !darwin

// Package ui's non-Windows stub. The Fyne GUI window is only built on Windows
// in this repo (Fyne needs a per-platform C toolchain). On other platforms this
// stub provides the same exported API so main compiles everywhere, but Run
// returns an error so main falls back to the console reconnect loop (and, where
// available, the pure-Go system tray).
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
