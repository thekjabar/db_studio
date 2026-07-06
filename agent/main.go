// Command dbstudio-agent is the local agent for DB Studio's tunnel. It connects
// outbound over WebSocket to the DB Studio server and acts as a raw TCP
// byte-pipe so the server can reach databases that are only reachable from the
// user's own network. See AGENT_TUNNEL_PROTOCOL.md for the wire contract.
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
	"dbstudio-agent/internal/tunnel"
)

// defaultServer is used when neither --server nor a saved config provides one.
const defaultServer = "wss://api.queryschema.com"

// defaultAppBase is the DB Studio frontend base URL used for browser auto-pair
// when neither --app nor a saved config provides one.
const defaultAppBase = "https://queryschema.com"

const (
	backoffMin = 1 * time.Second
	backoffMax = 30 * time.Second
)

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
	)
	flag.StringVar(&tokenFlag, "token", "", "pairing token from the DB Studio UI (skips browser auto-pair)")
	flag.StringVar(&serverFlag, "server", "", "server base URL, e.g. wss://api.queryschema.com (overrides config)")
	flag.StringVar(&appFlag, "app", "", "DB Studio app base URL for browser pairing, e.g. https://queryschema.com (overrides default)")
	flag.StringVar(&configFlag, "config", "", "path to config dir or config.json (default: OS user config dir)")
	flag.BoolVar(&noBrowserFlag, "no-browser", false, "do not launch a browser for pairing; print the URL and wait instead")
	flag.BoolVar(&versionFlag, "version", false, "print version and exit")
	flag.Parse()

	if versionFlag {
		fmt.Printf("dbstudio-agent %s\n", tunnel.Version)
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

	// Determine the token to authenticate with:
	//   - a fresh pairing token from --token always wins (re-pair / first run);
	//   - otherwise fall back to the saved refresh secret.
	// If neither is present, run the browser auto-pair flow to obtain a pairing
	// token instead of exiting. Only if that fails do we print the manual hint.
	pairingToken := tokenFlag
	if pairingToken == "" && cfg.RefreshSecret == "" {
		log.Printf("no pairing token and no saved credentials; starting browser pairing...")
		token, perr := pair.BrowserPair(ctx, appBase, agentName(), !noBrowserFlag)
		if perr != nil {
			log.Printf("browser pairing failed: %v", perr)
			log.Printf("run once with:  agent --token <PAIRING_TOKEN>  [--server %s]", server)
			os.Exit(2)
		}
		pairingToken = token
	}

	// Persist the server URL immediately (harmless, keeps config coherent).
	if err := config.Save(configFlag, cfg); err != nil {
		log.Printf("warning: could not save config: %v", err)
	}

	log.Printf("starting; server=%s", server)
	run(ctx, configFlag, cfg, pairingToken, appBase, !noBrowserFlag)
	log.Printf("stopped.")
}

// run is the reconnect loop. It keeps a session alive, reconnecting with
// exponential backoff. The pairing token (if any) is used only for the first
// attempt; after a successful ready with a refresh secret, subsequent attempts
// use the saved secret.
func run(ctx context.Context, configPath string, cfg *config.Config, pairingToken, appBase string, openBrowser bool) {
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

		client, err := tunnel.New(cfg.ServerURL, token)
		if err != nil {
			log.Fatalf("bad configuration: %v", err)
		}

		res, runErr := client.Run(ctx)

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

		// Self-heal: the server rejected our credentials (4401). This happens if
		// the saved refresh secret is stale/revoked (e.g. after a server upgrade,
		// or the agent was deleted). Looping forever on a dead secret is useless —
		// clear it and re-pair through the browser so the user gets back online
		// with one click instead of having to hunt down the config file.
		if tunnel.IsUnauthorized(runErr) {
			log.Printf("server rejected our credentials — re-pairing through the browser...")
			cfg.RefreshSecret = ""
			cfg.AgentID = ""
			_ = config.Save(configPath, cfg)
			newToken, perr := pair.BrowserPair(ctx, appBase, agentName(), openBrowser)
			if perr != nil {
				log.Printf("re-pairing failed: %v", perr)
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
