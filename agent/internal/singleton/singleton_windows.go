//go:build windows

// Package singleton provides a best-effort single-instance guard so
// double-clicking the agent twice does not spawn duplicate windows/tunnels.
//
// On Windows it uses a named kernel mutex: the first process creates it, and any
// later process sees ERROR_ALREADY_EXISTS and knows another instance is running.
// The mutex handle is held for the process lifetime (never released) so the OS
// frees it automatically when the process exits — even on a crash.
package singleton

import (
	"syscall"
	"unsafe"
)

// mutexName is a fixed, machine-global name for the agent's single-instance
// mutex. The "Local\\" prefix scopes it to the current user session, which is
// what we want (one instance per logged-in user).
const mutexName = `Local\dbstudio-agent-singleton`

// errAlreadyExists is the Windows error returned by CreateMutex when the named
// mutex already exists (i.e. another instance owns it).
const errAlreadyExists = 183 // ERROR_ALREADY_EXISTS

// held keeps the mutex handle alive for the process lifetime.
var held syscall.Handle

// Acquire tries to become the single instance. It returns true if this process
// is the first/only instance (caller should proceed), or false if another
// instance already holds the lock (caller should exit). On any unexpected error
// it fails open (returns true) so the guard never blocks a legitimate launch.
func Acquire() bool {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	createMutex := kernel32.NewProc("CreateMutexW")

	namePtr, err := syscall.UTF16PtrFromString(mutexName)
	if err != nil {
		return true // fail open
	}

	// CreateMutexW(NULL, FALSE, name) — don't take ownership, just create/open.
	h, _, callErr := createMutex.Call(
		0,
		0,
		uintptr(unsafe.Pointer(namePtr)),
	)
	if h == 0 {
		return true // could not create the mutex at all; fail open
	}
	handle := syscall.Handle(h)

	// GetLastError is surfaced through callErr; ERROR_ALREADY_EXISTS means a
	// prior instance created this mutex first.
	if errno, ok := callErr.(syscall.Errno); ok && int(errno) == errAlreadyExists {
		// Another instance is running. Close our handle and report "not first".
		_ = syscall.CloseHandle(handle)
		return false
	}

	// We are the first instance. Hold the handle for the process lifetime.
	held = handle
	return true
}
