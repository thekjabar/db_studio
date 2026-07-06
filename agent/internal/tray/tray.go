// Package tray runs the DB Studio agent as a background system-tray application.
// It wraps fyne.io/systray so the reconnect loop in main can drive a small,
// goroutine-safe API: Run installs the tray (blocking, on the main goroutine),
// SetStatus updates the icon/tooltip/menu from any goroutine, and the menu
// exposes "Open DB Studio" and "Quit".
//
// systray.Run MUST be called on the process's main goroutine, so main calls
// tray.Run and moves the reconnect loop into the onReady callback's goroutine.
package tray

import (
	"fmt"
	"os/exec"
	"runtime"
	"sync"

	"fyne.io/systray"
)

// appURL is the DB Studio frontend opened by the "Open DB Studio" menu item.
const appURL = "https://queryschema.com"

// Status is the coarse connection state shown in the tray.
type Status int

const (
	// Connecting: dialing the server (or between dial attempts within a session).
	Connecting Status = iota
	// Online: the session is established (server sent ready).
	Online
	// Offline: a session ended and we're about to retry / are backing off.
	Offline
	// Pairing: the browser auto-pair flow is in progress.
	Pairing
)

// menuLabel returns the disabled status-line text for a state.
func (s Status) menuLabel(detail string) string {
	base := "DB Studio Agent — "
	switch s {
	case Online:
		base += "Connected"
	case Connecting:
		base += "Connecting…"
	case Pairing:
		base += "Pairing…"
	case Offline:
		base += "Offline (retrying)"
	default:
		base += "…"
	}
	if detail != "" {
		base += " (" + detail + ")"
	}
	return base
}

// tooltip returns the short hover tooltip text for a state.
func (s Status) tooltip() string {
	switch s {
	case Online:
		return "DB Studio Agent — Connected"
	case Connecting:
		return "DB Studio Agent — Connecting…"
	case Pairing:
		return "DB Studio Agent — Pairing…"
	case Offline:
		return "DB Studio Agent — Offline (retrying)"
	default:
		return "DB Studio Agent"
	}
}

// online reports whether the state should use the "online" (green) icon.
func (s Status) online() bool { return s == Online }

// pkg-level tray state, guarded by mu. The menu items are created in the systray
// onReady callback and are nil until then; SetStatus tolerates being called
// before the tray is ready (it just records the pending status).
var (
	mu          sync.Mutex
	ready       bool
	statusItem  *systray.MenuItem
	curStatus   Status = Connecting
	curDetail   string
	lastOnline  = false
	haveApplied bool
)

// Run installs the system tray and blocks until Quit is selected (or systray
// tears down). It must be called on the main goroutine. onReady runs once the
// tray is up (spawn your background work there); onExit runs during teardown.
//
// systray.Run itself returns nothing, so Run detects failure two ways: it
// recovers from any panic raised while creating the tray, and if the event loop
// exits without onReady ever having fired it reports that the tray could not be
// created. Either way callers get a non-nil error and should fall back to a
// console loop.
func Run(onReady func(), onExit func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("system tray panicked: %v", r)
		}
	}()

	start := func() {
		mu.Lock()
		ready = true
		// Status line (disabled — it's a live label, not an action).
		statusItem = systray.AddMenuItem(curStatus.menuLabel(curDetail), "")
		statusItem.Disable()
		systray.AddSeparator()
		openItem := systray.AddMenuItem("Open DB Studio", "Open queryschema.com in your browser")
		systray.AddSeparator()
		quitItem := systray.AddMenuItem("Quit", "Stop the agent and exit")
		// Apply the current icon/tooltip now that the tray exists.
		haveApplied = false
		applyLocked()
		mu.Unlock()

		// Menu-click pump. systray delivers clicks on these channels.
		go func() {
			for {
				select {
				case <-openItem.ClickedCh:
					_ = openURL(appURL)
				case <-quitItem.ClickedCh:
					systray.Quit()
					return
				}
			}
		}()

		if onReady != nil {
			onReady()
		}
	}

	systray.Run(start, onExit)

	// If the loop returned but onReady never marked us ready, the tray was never
	// actually created — report that so the caller falls back to console mode.
	mu.Lock()
	up := ready
	mu.Unlock()
	if !up {
		return fmt.Errorf("system tray did not initialize")
	}
	return nil
}

// Quit tears the tray down programmatically (e.g. on SIGTERM). Safe to call even
// if the tray never came up.
func Quit() {
	systray.Quit()
}

// SetStatus updates the tray icon, tooltip, and status menu line. It is safe to
// call from any goroutine and before/after the tray is ready.
func SetStatus(s Status, detail string) {
	mu.Lock()
	defer mu.Unlock()
	curStatus = s
	curDetail = detail
	if ready {
		applyLocked()
	}
}

// applyLocked pushes curStatus/curDetail to systray. Caller must hold mu.
func applyLocked() {
	if statusItem != nil {
		statusItem.SetTitle(curStatus.menuLabel(curDetail))
	}
	systray.SetTooltip(curStatus.tooltip())
	// Only swap the icon when the online/offline bucket actually changes, to
	// avoid needless flicker on every minor status update.
	online := curStatus.online()
	if !haveApplied || online != lastOnline {
		if online {
			systray.SetIcon(iconOnline)
		} else {
			systray.SetIcon(iconOffline)
		}
		lastOnline = online
		haveApplied = true
	}
}

// openURL opens target in the user's default browser using the
// platform-appropriate launcher. It mirrors pair.openInBrowser but is duplicated
// here as a tiny helper so the tray package has no dependency on internal/pair.
func openURL(target string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	case "darwin":
		return exec.Command("open", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}
