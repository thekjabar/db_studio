//go:build !windows

package singleton

import "net"

// held keeps the loopback listener alive for the process lifetime so the OS
// releases the port automatically when the process exits.
var held net.Listener

// lockAddr is a fixed loopback address. Binding it succeeds for the first
// instance and fails ("address already in use") for any later instance.
const lockAddr = "127.0.0.1:47615"

// Acquire tries to become the single instance by binding a fixed loopback port.
// It returns true if this process is the first/only instance, false if the port
// is already taken (another instance is running).
func Acquire() bool {
	ln, err := net.Listen("tcp", lockAddr)
	if err != nil {
		// Port already bound by another instance.
		return false
	}
	held = ln // hold for process lifetime; never Close.
	return true
}
