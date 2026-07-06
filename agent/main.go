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
	"syscall"
	"time"

	"dbstudio-agent/internal/config"
	"dbstudio-agent/internal/tunnel"
)

// defaultServer is used when neither --server nor a saved config provides one.
const defaultServer = "wss://database-api.mrwari.com"

const (
	backoffMin = 1 * time.Second
	backoffMax = 30 * time.Second
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[dbstudio-agent] ")

	var (
		tokenFlag   string
		serverFlag  string
		configFlag  string
		versionFlag bool
	)
	flag.StringVar(&tokenFlag, "token", "", "pairing token from the DB Studio UI (only needed on first run / re-pair)")
	flag.StringVar(&serverFlag, "server", "", "server base URL, e.g. wss://database-api.mrwari.com (overrides config)")
	flag.StringVar(&configFlag, "config", "", "path to config dir or config.json (default: OS user config dir)")
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

	// Determine the token to authenticate with:
	//   - a fresh pairing token from --token always wins (re-pair / first run);
	//   - otherwise fall back to the saved refresh secret.
	// One of the two MUST be present or we cannot connect.
	if tokenFlag == "" && cfg.RefreshSecret == "" {
		log.Printf("no pairing token and no saved credentials.")
		log.Printf("run once with:  agent --token <PAIRING_TOKEN>  [--server %s]", server)
		os.Exit(2)
	}

	// Persist the server URL immediately (harmless, keeps config coherent).
	if err := config.Save(configFlag, cfg); err != nil {
		log.Printf("warning: could not save config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("starting; server=%s", server)
	run(ctx, configFlag, cfg, tokenFlag)
	log.Printf("stopped.")
}

// run is the reconnect loop. It keeps a session alive, reconnecting with
// exponential backoff. The pairing token (if any) is used only for the first
// attempt; after a successful ready with a refresh secret, subsequent attempts
// use the saved secret.
func run(ctx context.Context, configPath string, cfg *config.Config, pairingToken string) {
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
