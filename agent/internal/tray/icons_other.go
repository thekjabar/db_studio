//go:build !windows

package tray

import _ "embed"

// macOS and Linux systray backends expect PNG bytes.

//go:embed icon_online.png
var iconOnline []byte

//go:embed icon_offline.png
var iconOffline []byte
