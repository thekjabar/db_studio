//go:build windows

// Package ui runs the DB Studio agent as a real desktop window using WebView2
// (the Edge engine built into every Windows 10/11). Unlike the Fyne/OpenGL
// build — whose GLFW window never became visible on some machines — WebView2
// renders a normal, reliable app window with a taskbar icon, and its UI is
// styled HTML/CSS so it looks like a polished mini desktop app.
//
// webview.Run() MUST own the process's main goroutine (it blocks), so main()
// calls Run and the reconnect loop is started from a goroutine before Run
// blocks. Cross-thread UI updates (from the reconnect loop) are marshalled onto
// the WebView UI thread with w.Dispatch, which then calls w.Eval to run JS.
package ui

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	webview "github.com/webview/webview_go"
)

// appURL is opened by the "Open DB Studio" button.
const appURL = "https://queryschema.com"

// Status is the coarse connection state shown in the window. Values mirror
// internal/tray.Status ordering so main's trayToUI mapping stays valid.
type Status int

const (
	Connecting Status = iota
	Online
	Offline
	Pairing
)

// jsState is the string the HTML/JS uses for each status (drives the dot color).
func (s Status) jsState() string {
	switch s {
	case Online:
		return "online"
	case Pairing:
		return "pairing"
	case Offline:
		return "offline"
	default:
		return "connecting"
	}
}

// label is the human-readable status text shown in the window.
func (s Status) label() string {
	switch s {
	case Online:
		return "Connected"
	case Pairing:
		return "Pairing…"
	case Offline:
		return "Offline — retrying"
	default:
		return "Connecting…"
	}
}

var (
	mu sync.Mutex
	w  webview.WebView // the window; nil until Run creates it

	// Buffered latest state, so SetStatus/SetIdentity called before the page has
	// loaded are applied once it's ready (via the bound uiReady callback).
	curStatus Status = Connecting
	curDetail string
	idName    string
	idHost    string
	pageReady bool

	onQuitFn func()
	quitOnce sync.Once
)

// SetIdentity records the agent name + server host shown in the window.
func SetIdentity(name, host string) {
	mu.Lock()
	idName = name
	idHost = host
	up := w != nil && pageReady
	mu.Unlock()
	if up {
		dispatchEval(fmt.Sprintf("setIdentity(%s,%s)", jsStr(name), jsStr(host)))
	}
}

// SetStatus updates the status dot + label. Safe from any goroutine.
func SetStatus(s Status, detail string) {
	mu.Lock()
	curStatus = s
	curDetail = detail
	up := w != nil && pageReady
	mu.Unlock()
	if up {
		dispatchEval(fmt.Sprintf("setStatus(%s,%s)", jsStr(s.jsState()), jsStr(labelWithDetail(s, detail))))
	}
}

func labelWithDetail(s Status, detail string) string {
	if detail != "" {
		return s.label() + " (" + detail + ")"
	}
	return s.label()
}

// Run creates the WebView2 window, wires the buttons, starts onReady in a
// goroutine, and blocks on w.Run() until the window is closed / Quit clicked.
// It MUST be called on the process's main goroutine.
func Run(onReady func(), onQuit func()) (err error) {
	// webview.New panics if the WebView2 runtime is missing; recover so main can
	// fall back to the console loop instead of crashing.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("webview window unavailable: %v", r)
		}
	}()

	mu.Lock()
	onQuitFn = onQuit
	mu.Unlock()

	wv := webview.New(false)
	if wv == nil {
		return fmt.Errorf("could not create webview window")
	}
	mu.Lock()
	w = wv
	mu.Unlock()

	wv.SetTitle("DB Studio Agent")
	wv.SetSize(420, 360, webview.HintFixed)

	// Bindings the HTML page calls.
	wv.Bind("openDBStudio", func() { _ = openURL(appURL) })
	wv.Bind("quitApp", func() {
		go func() {
			fireQuit()
			wv.Dispatch(func() { wv.Terminate() })
		}()
	})
	// uiReady is called by the page once its DOM + JS are loaded. We push the
	// current buffered status/identity so nothing set before load is lost.
	wv.Bind("uiReady", func() {
		mu.Lock()
		pageReady = true
		s, d, n, h := curStatus, curDetail, idName, idHost
		mu.Unlock()
		wv.Dispatch(func() {
			wv.Eval(fmt.Sprintf("setIdentity(%s,%s)", jsStr(n), jsStr(h)))
			wv.Eval(fmt.Sprintf("setStatus(%s,%s)", jsStr(s.jsState()), jsStr(labelWithDetail(s, d))))
		})
	})

	wv.SetHtml(pageHTML)

	if onReady != nil {
		go onReady()
	}

	wv.Run() // blocks until the window closes

	fireQuit()
	mu.Lock()
	w = nil
	pageReady = false
	mu.Unlock()
	return nil
}

// Quit closes the window from another goroutine.
func Quit() {
	mu.Lock()
	wv := w
	mu.Unlock()
	if wv != nil {
		wv.Dispatch(func() { wv.Terminate() })
	}
}

func fireQuit() {
	quitOnce.Do(func() {
		mu.Lock()
		f := onQuitFn
		mu.Unlock()
		if f != nil {
			f()
		}
	})
}

// dispatchEval runs a JS snippet on the WebView UI thread (required — Eval is
// not safe from arbitrary goroutines).
func dispatchEval(js string) {
	mu.Lock()
	wv := w
	mu.Unlock()
	if wv != nil {
		wv.Dispatch(func() { wv.Eval(js) })
	}
}

// jsStr safely encodes a Go string as a JS string literal.
func jsStr(s string) string {
	// strconv.Quote gives a valid double-quoted, escaped literal that JS accepts.
	return strconv.Quote(s)
}

// openURL opens target in the default browser (Windows).
func openURL(target string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
}

// pageHTML is the embedded UI. Dark, modern, brand-teal accent. Defines the
// setStatus/setIdentity JS the Go side calls, and calls uiReady() on load.
var pageHTML = strings.TrimSpace(`
<!doctype html><html><head><meta charset="utf-8">
<style>
  :root{--bg:#0b0f14;--card:#111820;--fg:#e6edf3;--muted:#8b98a5;--accent:#10b981;--border:#1e2a35;}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-user-select:none;user-select:none}
  html,body{height:100%}
  body{background:var(--bg);color:var(--fg);font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
       display:flex;align-items:center;justify-content:center;padding:18px}
  .card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--border);
        border-radius:16px;padding:22px 22px 18px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  .brand{display:flex;align-items:center;gap:9px;margin-bottom:16px}
  .brand .logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#10b981,#059669);
        display:flex;align-items:center;justify-content:center;font-weight:700;color:#04120c;font-size:14px}
  .brand h1{font-size:15px;font-weight:600;letter-spacing:.2px}
  .status{display:flex;align-items:center;gap:12px;padding:16px 0 6px}
  .dot{width:14px;height:14px;border-radius:50%;background:var(--muted);flex:none;
       box-shadow:0 0 0 0 rgba(16,185,129,.5);transition:background .3s}
  .dot.online{background:#10b981;animation:pulse 2s infinite}
  .dot.connecting{background:#f59e0b}
  .dot.pairing{background:#3b82f6}
  .dot.offline{background:#6b7280}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}70%{box-shadow:0 0 0 8px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}
  #stat{font-size:19px;font-weight:600}
  .sub{color:var(--muted);font-size:12.5px;line-height:1.5;margin:2px 0 18px;min-height:34px}
  .sub b{color:var(--fg);font-weight:600}
  .btns{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  button{font:inherit;font-size:13px;font-weight:600;padding:11px;border-radius:10px;border:1px solid var(--border);
         cursor:pointer;transition:.15s}
  .primary{background:var(--accent);color:#04120c;border-color:transparent}
  .primary:hover{background:#0ea371}
  .ghost{background:transparent;color:var(--muted)}
  .ghost:hover{background:#182029;color:var(--fg)}
  .foot{text-align:center;color:#586675;font-size:11px;margin-top:14px}
</style></head>
<body>
  <div class="card">
    <div class="brand"><div class="logo">DB</div><h1>DB Studio Agent</h1></div>
    <div class="status"><div id="dot" class="dot connecting"></div><div id="stat">Connecting…</div></div>
    <div class="sub" id="sub">Linking your database to DB Studio…</div>
    <div class="btns">
      <button class="primary" onclick="openDBStudio()">Open DB Studio</button>
      <button class="ghost" onclick="quitApp()">Quit</button>
    </div>
    <div class="foot">Keep this app running while you use your database in DB Studio.</div>
  </div>
<script>
  function setStatus(state, text){
    var d=document.getElementById('dot'); d.className='dot '+state;
    document.getElementById('stat').textContent=text;
  }
  function setIdentity(name, host){
    var s=document.getElementById('sub');
    if(name||host){ s.innerHTML='Connected as <b>'+(name||'this machine')+'</b>'+(host?(' · '+host):''); }
  }
  window.addEventListener('load', function(){ try{ uiReady(); }catch(e){} });
</script>
</body></html>
`)
