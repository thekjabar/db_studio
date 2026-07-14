// Command dbstudio-agent is the local agent for Query Schema's tunnel. It connects
// outbound over WebSocket to the Query Schema server and acts as a raw TCP
// byte-pipe so the server can reach databases that are only reachable from the
// user's own network. See AGENT_TUNNEL_PROTOCOL.md for the wire contract.
//
// The agent runs as a real desktop window application (WebView2): double-clicking it
// opens a visible window that shows in the OS taskbar with its own icon, like a
// normal app. The window's status line reflects the live connection state and
// its buttons let the user open Query Schema or quit. Because the binary is built
// with -H=windowsgui there is no separate console window — just the app window.
// If the GUI cannot be created (e.g. a headless machine, or --console was
// passed) the agent falls back to the plain console reconnect loop.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"dbstudio-agent/internal/config"
	"dbstudio-agent/internal/pair"
	"dbstudio-agent/internal/singleton"
	"dbstudio-agent/internal/tunnel"
	"dbstudio-agent/internal/ui"
)

// defaultServer is used when neither --server nor a saved config provides one.
const defaultServer = "wss://api.queryschema.com"

// defaultAppBase is the Query Schema frontend base URL used for browser auto-pair
// when neither --app nor a saved config provides one.
const defaultAppBase = "https://queryschema.com"

const (
	backoffMin = 1 * time.Second
	backoffMax = 30 * time.Second
)

// runParams bundles everything the reconnect loop needs. It is assembled in
// main() and consumed either by the tray's onReady goroutine or the console
// fallback.
type runParams struct {
	ctx          context.Context
	configPath   string
	cfg          *config.Config
	pairingToken string
	appBase      string
	openBrowser  bool
	server       string
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[dbstudio-agent] ")

	var (
		tokenFlag     string
		serverFlag    string
		appFlag       string
		configFlag    string
		noBrowserFlag bool
		versionFlag   bool
		consoleFlag   bool
	)
	flag.StringVar(&tokenFlag, "token", "", "pairing token from the Query Schema UI (skips browser auto-pair)")
	flag.StringVar(&serverFlag, "server", "", "server base URL, e.g. wss://api.queryschema.com (overrides config)")
	flag.StringVar(&appFlag, "app", "", "Query Schema app base URL for browser pairing, e.g. https://queryschema.com (overrides default)")
	flag.StringVar(&configFlag, "config", "", "path to config dir or config.json (default: OS user config dir)")
	flag.BoolVar(&noBrowserFlag, "no-browser", false, "do not launch a browser for pairing; print the URL and wait instead")
	flag.BoolVar(&versionFlag, "version", false, "print version and exit")
	flag.BoolVar(&consoleFlag, "console", false, "run headless in the console (no GUI window)")
	flag.Parse()

	// --version must print and exit BEFORE any GUI/config work.
	if versionFlag {
		fmt.Printf("dbstudio-agent %s\n", tunnel.Version)
		return
	}

	// Single-instance guard: if another copy of the agent is already running,
	// exit quietly rather than spawning a duplicate window/tunnel. Only enforced
	// for the GUI (default) path — --console is for scripting/debugging where
	// multiple instances may be intentional.
	if !consoleFlag && !singleton.Acquire() {
		log.Printf("another instance is already running; exiting.")
		return
	}

	cfg, err := config.Load(configFlag)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	// Resolve the server URL: flag > config > default.
	server := firstNonEmpty(serverFlag, cfg.ServerURL, defaultServer)
	cfg.ServerURL = server

	// Resolve the app (browser) base URL: flag > default.
	appBase := firstNonEmpty(appFlag, defaultAppBase)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Persist the server URL immediately (harmless, keeps config coherent).
	if err := config.Save(configFlag, cfg); err != nil {
		log.Printf("warning: could not save config: %v", err)
	}

	params := &runParams{
		ctx:          ctx,
		configPath:   configFlag,
		cfg:          cfg,
		pairingToken: tokenFlag,
		appBase:      appBase,
		openBrowser:  !noBrowserFlag,
		server:       server,
	}

	// Console mode: skip the GUI entirely and run the old loop on this
	// goroutine. Useful when invoked from a terminal or on headless machines.
	if consoleFlag {
		runConsole(params)
		return
	}

	// Window mode: the WebView2 window owns the main goroutine (webview.Run blocks), so the
	// reconnect loop runs in a goroutine launched from onReady. onQuit fires when
	// the window is closed / Quit is clicked; cancelling the context there stops
	// the loop.
	ui.SetIdentity(agentName(), serverHost(server))

	onReady := func() {
		pairAndRun(params)
	}
	onQuit := func() {
		stop() // cancel the context so the reconnect loop unwinds
	}

	// If the user hits Ctrl+C / SIGTERM (e.g. launched from a console), close the
	// window too so the process exits cleanly.
	go func() {
		<-ctx.Done()
		ui.Quit()
	}()

	if err := ui.Run(onReady, onQuit); err != nil {
		// The GUI could not be created (headless / no display). Fall back to the
		// console loop so the agent still works.
		log.Printf("GUI window unavailable (%v); falling back to console mode", err)
		runConsole(params)
		return
	}
	log.Printf("stopped.")
}

// serverHost extracts a compact host label from a ws/wss/http(s) server URL for
// display in the window (e.g. "wss://api.queryschema.com" -> "api.queryschema.com").
func serverHost(server string) string {
	s := server
	for _, p := range []string{"wss://", "ws://", "https://", "http://"} {
		s = strings.TrimPrefix(s, p)
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	return s
}

// runConsole runs the pairing + reconnect loop on the calling goroutine with no
// tray. Status updates are dropped (the no-op setter). This is the original
// behavior, preserved for --console and the headless fallback.
func runConsole(p *runParams) {
	log.Printf("starting; server=%s", p.server)
	pairAndRunWith(p, func(ui.Status, string) {})
	log.Printf("stopped.")
}

// pairAndRun is the window-mode entrypoint: it drives ui.SetStatus (bridged from
// the loop's tray.Status callback) as the connection state changes.
func pairAndRun(p *runParams) {
	log.Printf("starting; server=%s", p.server)
	pairAndRunWith(p, func(s ui.Status, detail string) {
		ui.SetStatus(s, detail)
	})
	log.Printf("stopped.")
	// The loop returned (ctx cancelled or unrecoverable). Ensure the window
	// closes so the process exits rather than lingering.
	ui.Quit()
}

// pairAndRunWith performs the first-run pairing (if needed) then enters the
// reconnect loop, reporting state through setStatus.
func pairAndRunWith(p *runParams, setStatus func(ui.Status, string)) {
	// Determine the token to authenticate with:
	//   - a fresh pairing token from --token always wins (re-pair / first run);
	//   - otherwise fall back to the saved refresh secret.
	// If neither is present, run the browser auto-pair flow to obtain a pairing
	// token instead of exiting.
	pairingToken := p.pairingToken
	if pairingToken == "" && p.cfg.RefreshSecret == "" {
		log.Printf("no pairing token and no saved credentials; starting browser pairing...")
		setStatus(ui.Pairing, "")
		token, perr := pair.BrowserPair(p.ctx, p.appBase, agentName(), p.openBrowser)
		if perr != nil {
			log.Printf("browser pairing failed: %v", perr)
			log.Printf("run once with:  agent --token <PAIRING_TOKEN>  [--server %s]", p.server)
			setStatus(ui.Offline, "pairing failed")
			return
		}
		pairingToken = token
	}

	run(p.ctx, p.configPath, p.cfg, pairingToken, p.appBase, p.openBrowser, setStatus)
}

// run is the reconnect loop. It keeps a session alive, reconnecting with
// exponential backoff. The pairing token (if any) is used only for the first
// attempt; after a successful ready with a refresh secret, subsequent attempts
// use the saved secret. setStatus is called as the connection state changes.
func run(ctx context.Context, configPath string, cfg *config.Config, pairingToken, appBase string, openBrowser bool, setStatus func(ui.Status, string)) {
	backoff := backoffMin
	// token used for the NEXT dial; starts as the pairing token if provided.
	token := pairingToken
	if token == "" {
		token = cfg.RefreshSecret
	}

	for {
		if ctx.Err() != nil {
			return
		}

		setStatus(ui.Connecting, "")

		client, err := tunnel.New(cfg.ServerURL, token)
		if err != nil {
			log.Fatalf("bad configuration: %v", err)
		}

		// Flip to Online once the server's ready frame lands. WaitReady blocks
		// on the client's ready channel; we run it in a goroutine so it does not
		// interfere with client.Run below. onlineCtx is cancelled when the
		// session ends so the waiter never leaks.
		onlineCtx, onlineCancel := context.WithCancel(ctx)
		go func() {
			if err := client.WaitReady(onlineCtx); err == nil {
				setStatus(ui.Online, "")
			}
		}()

		res, runErr := client.Run(ctx)
		onlineCancel()

		// Persist any credentials the server handed back so we can reconnect
		// without the pairing token next time.
		if updateCredentials(cfg, res) {
			if err := config.Save(configPath, cfg); err != nil {
				log.Printf("warning: could not save credentials: %v", err)
			} else {
				log.Printf("saved agent credentials to config")
			}
			// After the first successful pairing, always reconnect with the
			// long-lived refresh secret rather than the one-time token.
			token = cfg.RefreshSecret
			// A clean session resets the backoff.
			backoff = backoffMin
		}

		if ctx.Err() != nil {
			return
		}

		if runErr != nil {
			log.Printf("session ended: %v", runErr)
		} else {
			log.Printf("session ended: connection closed")
		}
		setStatus(ui.Offline, "")

		// Self-heal: the server rejected our credentials (4401). This happens if
		// the saved refresh secret is stale/revoked (e.g. after a server upgrade,
		// or the agent was deleted). Looping forever on a dead secret is useless —
		// clear it and re-pair through the browser so the user gets back online
		// with one click instead of having to hunt down the config file.
		if tunnel.IsUnauthorized(runErr) {
			log.Printf("server rejected our credentials — re-pairing through the browser...")
			setStatus(ui.Pairing, "")
			cfg.RefreshSecret = ""
			cfg.AgentID = ""
			_ = config.Save(configPath, cfg)
			newToken, perr := pair.BrowserPair(ctx, appBase, agentName(), openBrowser)
			if perr != nil {
				log.Printf("re-pairing failed: %v", perr)
				setStatus(ui.Offline, "pairing failed")
				return
			}
			token = newToken
			backoff = backoffMin
			continue
		}

		// If we still have no way to authenticate (never got a refresh secret
		// and had no pairing token to begin with) there is no point retrying.
		if token == "" {
			log.Printf("no credentials to reconnect with; run again with --token")
			return
		}

		log.Printf("reconnecting in %s...", backoff)
		if !sleepCtx(ctx, backoff) {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

// updateCredentials copies any agentId/refreshSecret from a session result into
// cfg, returning true if anything changed.
func updateCredentials(cfg *config.Config, res tunnel.Result) bool {
	changed := false
	if res.AgentID != "" && res.AgentID != cfg.AgentID {
		cfg.AgentID = res.AgentID
		changed = true
	}
	if res.RefreshSecret != "" && res.RefreshSecret != cfg.RefreshSecret {
		cfg.RefreshSecret = res.RefreshSecret
		changed = true
	}
	return changed
}

// nextBackoff doubles the backoff up to backoffMax.
func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > backoffMax {
		return backoffMax
	}
	return d
}

// sleepCtx sleeps for d or until ctx is cancelled. It returns false if ctx was
// cancelled (caller should stop).
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// agentName returns the machine hostname to propose as this agent's name during
// browser pairing, falling back to "agent" if the hostname is unavailable.
func agentName() string {
	h, err := os.Hostname()
	if err != nil {
		return "agent"
	}
	h = strings.TrimSpace(h)
	if h == "" {
		return "agent"
	}
	return h
}
