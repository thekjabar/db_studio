//go:build windows

package tray

import _ "embed"

// On Windows systray expects ICO bytes for a crisp tray icon.

//go:embed icon_online.ico
var iconOnline []byte

//go:embed icon_offline.ico
var iconOffline []byte
