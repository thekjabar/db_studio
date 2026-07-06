//go:build windows

package ui

import _ "embed"

// appIconPNG is the application icon shown in the window title bar and the
// OS taskbar. It is a 256x256 PNG (a blue database badge) so the taskbar
// entry looks like a real desktop app rather than a tiny tray glyph.
//
//go:embed icon.png
var appIconPNG []byte
