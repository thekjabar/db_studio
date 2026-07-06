//go:build windows

// Package ui runs the DB Studio agent as a real desktop window application
// (Fyne). Unlike the system-tray build, this opens a visible window that shows
// in the OS taskbar with its own icon, like WhatsApp/Chrome/VS Code.
//
// This Fyne implementation is Windows-only in this repo because Fyne requires a
// per-platform C toolchain (CGO); the Windows build uses the bundled MinGW-w64
// compiler. On non-Windows hosts a stub (ui_other.go) makes Run return an error
// so main falls back to the console reconnect loop, keeping the pure-Go Linux
// build intact.
//
// The window shows a live connection status line (a coloured dot + label), the
// agent name/host it is connecting as, the server host, and two buttons: "Open
// DB Studio" and "Quit". A small scrolling log shows recent status transitions.
//
// Fyne requires the app to own the process's main goroutine (app.Run blocks),
// so main() calls Run and moves the reconnect loop into the onReady callback's
// goroutine — mirroring how the tray package worked. All UI mutations from
// background goroutines are marshalled onto Fyne's main thread with fyne.Do so
// they are race-free.
package ui

import (
	"fmt"
	"image/color"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// appURL is the DB Studio frontend opened by the "Open DB Studio" button.
const appURL = "https://queryschema.com"

// Status is the coarse connection state shown in the window. The values mirror
// internal/tray.Status so main can drive either front-end interchangeably.
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

// label returns the human-readable status text.
func (s Status) label() string {
	switch s {
	case Online:
		return "Connected"
	case Connecting:
		return "Connecting…"
	case Pairing:
		return "Pairing…"
	case Offline:
		return "Offline — retrying"
	default:
		return "…"
	}
}

// dotColor returns the colour of the status dot for a state.
func (s Status) dotColor() color.Color {
	switch s {
	case Online:
		return color.NRGBA{R: 0x22, G: 0xc5, B: 0x5e, A: 0xff} // green
	case Connecting:
		return color.NRGBA{R: 0xf5, G: 0x9e, B: 0x0b, A: 0xff} // amber
	case Pairing:
		return color.NRGBA{R: 0x3b, G: 0x82, B: 0xf6, A: 0xff} // blue
	case Offline:
		return color.NRGBA{R: 0x9c, G: 0xa3, B: 0xaf, A: 0xff} // grey
	default:
		return color.NRGBA{R: 0x9c, G: 0xa3, B: 0xaf, A: 0xff}
	}
}

// pkg-level window state. Built once in Run; SetStatus tolerates being called
// before Run has finished wiring things up (it records the pending status and
// applies it as soon as the widgets exist).
var (
	mu sync.Mutex

	fyneApp    fyne.App
	win        fyne.Window
	widgetsUp  bool
	quitOnce   sync.Once
	onQuitFunc func()

	// widgets driven by SetStatus.
	dot        *canvas.Circle
	statusText *canvas.Text
	logEntry   *widget.Label
	logScroll  *container.Scroll

	// last recorded status (applied once widgets exist).
	curStatus Status = Connecting
	curDetail string

	// recent log lines (most recent last), capped.
	logLines []string
)

const maxLogLines = 200

// Run creates the Fyne app + window, shows it, invokes onReady once (spawn your
// background reconnect loop there), and blocks on app.Run until the window is
// closed or Quit is pressed. It MUST be called on the process's main goroutine.
//
// onQuit fires exactly once when the app is shutting down (window closed or Quit
// clicked) so callers can cancel their context and unwind the reconnect loop.
func Run(onReady func(), onQuit func()) error {
	mu.Lock()
	onQuitFunc = onQuit
	mu.Unlock()

	a := app.NewWithID("com.queryschema.dbstudio.agent")
	a.SetIcon(fyne.NewStaticResource("appicon.png", appIconPNG))

	w := a.NewWindow("DB Studio Agent")
	w.SetIcon(fyne.NewStaticResource("appicon.png", appIconPNG))

	// --- status line: coloured dot + big label ---
	d := canvas.NewCircle(curStatus.dotColor())
	// GridWrap forces the circle to a fixed 16x16 cell so it renders as a dot
	// rather than stretching to fill the row.
	dotBox := container.NewGridWrap(fyne.NewSize(16, 16), d)

	st := canvas.NewText(curStatus.label(), theme.Color(theme.ColorNameForeground))
	st.TextSize = 20
	st.TextStyle = fyne.TextStyle{Bold: true}

	statusRow := container.NewHBox(
		container.NewCenter(dotBox),
		container.NewCenter(st),
	)

	// --- secondary line: agent identity + server host ---
	subtitle := widget.NewLabel(subtitleText())
	subtitle.Wrapping = fyne.TextWrapWord

	// --- recent log area (small, scrolling) ---
	lg := widget.NewLabel("")
	lg.Wrapping = fyne.TextWrapWord
	scroll := container.NewVScroll(lg)
	scroll.SetMinSize(fyne.NewSize(340, 88))

	// --- buttons ---
	openBtn := widget.NewButtonWithIcon("Open DB Studio", theme.ComputerIcon(), func() {
		_ = openURL(appURL)
	})
	openBtn.Importance = widget.HighImportance
	quitBtn := widget.NewButtonWithIcon("Quit", theme.CancelIcon(), func() {
		Quit()
	})
	buttons := container.NewGridWithColumns(2, openBtn, quitBtn)

	content := container.NewVBox(
		widget.NewLabel(""), // small top spacer
		statusRow,
		subtitle,
		widget.NewSeparator(),
		widget.NewLabelWithStyle("Recent activity", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		scroll,
		widget.NewSeparator(),
		buttons,
	)
	w.SetContent(container.NewPadded(content))
	w.Resize(fyne.NewSize(380, 300))
	w.SetFixedSize(false)

	// Closing the window (X) quits the whole app and unwinds the loop.
	w.SetCloseIntercept(func() {
		Quit()
	})

	// Publish the widgets so SetStatus can drive them, then apply whatever
	// status was recorded before the window existed.
	mu.Lock()
	fyneApp = a
	win = w
	dot = d
	statusText = st
	logEntry = lg
	logScroll = scroll
	widgetsUp = true
	applyLocked()
	appendLogLocked(fmt.Sprintf("Agent started — %s", subtitleText()))
	mu.Unlock()

	w.Show()

	if onReady != nil {
		// onReady spawns background work; run it after Show so the window is
		// already visible when the reconnect loop starts reporting status.
		go onReady()
	}

	a.Run() // blocks until the app quits

	// app.Run returned: ensure onQuit fired (covers OS-level close paths).
	fireQuit()
	return nil
}

// Quit shuts the app down: fires onQuit once, then stops the Fyne event loop so
// app.Run returns and the process exits. Safe to call from any goroutine —
// fyne.App.Quit signals the driver to stop and does not require being on the UI
// thread.
func Quit() {
	fireQuit()
	mu.Lock()
	a := fyneApp
	mu.Unlock()
	if a != nil {
		a.Quit()
	}
}

// fireQuit invokes the caller's onQuit callback exactly once.
func fireQuit() {
	mu.Lock()
	cb := onQuitFunc
	mu.Unlock()
	quitOnce.Do(func() {
		if cb != nil {
			cb()
		}
	})
}

// SetStatus updates the status dot, label, and appends a log line. It is safe
// to call from any goroutine and before/after the window is built; the actual
// widget mutation is marshalled onto Fyne's UI thread with fyne.Do.
func SetStatus(s Status, detail string) {
	mu.Lock()
	curStatus = s
	curDetail = detail
	line := s.label()
	if detail != "" {
		line += " (" + detail + ")"
	}
	up := widgetsUp
	mu.Unlock()

	if !up {
		// Window not built yet: record the log line so it shows once it is.
		mu.Lock()
		appendLogLocked(stamp(line))
		mu.Unlock()
		return
	}

	// Marshal all widget writes onto the UI thread.
	fyne.Do(func() {
		mu.Lock()
		defer mu.Unlock()
		applyLocked()
		appendLogLocked(stamp(line))
	})
}

// applyLocked pushes curStatus/curDetail to the dot + status label. Caller must
// hold mu and be on the UI thread (or before the loop starts).
func applyLocked() {
	if dot != nil {
		dot.FillColor = curStatus.dotColor()
		dot.Refresh()
	}
	if statusText != nil {
		txt := curStatus.label()
		if curDetail != "" {
			txt += " (" + curDetail + ")"
		}
		statusText.Text = txt
		statusText.Color = theme.Color(theme.ColorNameForeground)
		statusText.Refresh()
	}
}

// appendLogLocked adds a line to the rolling activity log and refreshes the
// on-screen label. Caller must hold mu.
func appendLogLocked(line string) {
	logLines = append(logLines, line)
	if len(logLines) > maxLogLines {
		logLines = logLines[len(logLines)-maxLogLines:]
	}
	if logEntry != nil {
		text := ""
		for i, l := range logLines {
			if i > 0 {
				text += "\n"
			}
			text += l
		}
		logEntry.SetText(text)
		if logScroll != nil {
			logScroll.ScrollToBottom()
		}
	}
}

// stamp prefixes a log line with a short HH:MM:SS timestamp.
func stamp(line string) string {
	return time.Now().Format("15:04:05") + "  " + line
}

// --- identity shown in the window ---

var (
	agentIdentity string
	serverHost    string
)

// SetIdentity sets the agent name and server host shown on the secondary line.
// Call it before Run (or it can be called after; the label refreshes on the
// next SetStatus). Kept simple: main passes the hostname + server here.
func SetIdentity(name, server string) {
	mu.Lock()
	agentIdentity = name
	serverHost = server
	mu.Unlock()
}

// subtitleText builds the "as <name> · <server>" secondary line.
func subtitleText() string {
	mu.Lock()
	name := agentIdentity
	srv := serverHost
	mu.Unlock()
	switch {
	case name != "" && srv != "":
		return fmt.Sprintf("as %s  ·  %s", name, srv)
	case name != "":
		return "as " + name
	case srv != "":
		return srv
	default:
		return "DB Studio local tunnel agent"
	}
}

// openURL opens target in the user's default browser using the
// platform-appropriate launcher (mirrors the tray/pair helpers).
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
