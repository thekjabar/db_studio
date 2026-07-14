// Package pair implements the browser-based auto-pairing flow for the Query Schema
// agent (see AGENT_AUTOPAIR_PROTOCOL.md). When the agent starts with no pairing
// token and no saved credentials, it opens the user's browser to the Query Schema
// authorize page and runs a loopback "OAuth-like" round-trip: the SPA mints a
// short-lived pairing token and redirects the browser to a local callback server
// this package runs, which hands the token back to the caller.
package pair

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// pairTimeout bounds how long we wait for the user to complete the browser
// round-trip before giving up and telling them to use --token instead.
const pairTimeout = 5 * time.Minute

// successHTML is shown in the browser after a valid callback is received.
const successHTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Query Schema Agent — Paired</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; text-align: center; color: #1a1a1a;">
  <h1 style="font-size: 1.5rem;">Paired!</h1>
  <p style="font-size: 1rem; color: #444;">You can close this tab and return to the agent.</p>
</body>
</html>`

// BrowserPair runs the loopback auto-pair flow and returns a pairing token.
//
// appBase is the Query Schema frontend base URL (e.g. https://queryschema.com).
// agentName is the human-readable name proposed for this agent (typically the
// machine hostname). If openBrowser is false, BrowserPair only prints the
// authorize URL and waits for the user to open it manually (--no-browser).
//
// It starts an ephemeral loopback HTTP server on 127.0.0.1, opens the browser to
// the authorize URL, and blocks until the browser redirects back to the local
// /callback with a valid token, until ctx is cancelled, or until a 5-minute
// timeout elapses. The loopback server is shut down before returning.
func BrowserPair(ctx context.Context, appBase, agentName string, openBrowser bool) (string, error) {
	state, err := randomState()
	if err != nil {
		return "", fmt.Errorf("generate pairing state: %w", err)
	}

	// Bind an ephemeral loopback-only port. Never 0.0.0.0 — the callback (and the
	// pairing token it carries) must never be reachable off this machine.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("start loopback callback server: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	callbackURL := fmt.Sprintf("http://127.0.0.1:%d/callback", port)

	// tokenCh delivers the token from the /callback handler to this function.
	// Buffered so the handler never blocks even if we've already returned.
	tokenCh := make(chan string, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		// state is a CSRF/nonce binding this browser round-trip to THIS process.
		if q.Get("state") != state {
			http.Error(w, "invalid state parameter", http.StatusBadRequest)
			return
		}
		token := q.Get("token")
		if token == "" {
			http.Error(w, "missing token parameter", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(successHTML))
		// Deliver the token; the select below shuts the server down.
		select {
		case tokenCh <- token:
		default:
		}
	})

	srv := &http.Server{Handler: mux}
	go func() {
		// Serve blocks until Shutdown/Close; ErrServerClosed is the normal exit.
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("pair: callback server error: %v", err)
		}
	}()

	authorizeURL := buildAuthorizeURL(appBase, callbackURL, state, agentName)

	if openBrowser {
		if err := openInBrowser(authorizeURL); err != nil {
			log.Printf("pair: could not open browser automatically: %v", err)
		}
	}
	// Always print the URL so the user can complete the flow manually if the
	// browser did not open (or --no-browser was passed).
	log.Printf("To pair this agent, a browser window should have opened.")
	log.Printf("If your browser didn't open, visit: %s", authorizeURL)

	// Wait for a valid callback, cancellation, or the timeout.
	timer := time.NewTimer(pairTimeout)
	defer timer.Stop()

	var token string
	var pairErr error
	select {
	case token = <-tokenCh:
		log.Printf("pair: received pairing token from browser.")
	case <-ctx.Done():
		pairErr = ctx.Err()
	case <-timer.C:
		pairErr = fmt.Errorf("timed out waiting for browser pairing after %s; run again with --token <PAIRING_TOKEN> instead", pairTimeout)
	}

	// Shut the loopback server down after one valid callback (or on give-up).
	// Give in-flight responses a moment to flush before forcing close.
	shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)

	if pairErr != nil {
		return "", pairErr
	}
	return token, nil
}

// randomState returns a base64url-encoded 32-byte random string used as the CSRF
// nonce for the pairing round-trip.
func randomState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// buildAuthorizeURL constructs the Query Schema authorize URL the browser is sent
// to:
//
//	<appBase>/agent/authorize?callback=<enc>&state=<state>&name=<enc>
func buildAuthorizeURL(appBase, callbackURL, state, agentName string) string {
	base := strings.TrimRight(strings.TrimSpace(appBase), "/")
	q := url.Values{}
	q.Set("callback", callbackURL)
	q.Set("state", state)
	q.Set("name", agentName)
	return base + "/agent/authorize?" + q.Encode()
}

// openInBrowser opens the given URL in the user's default browser using the
// platform-appropriate launcher.
func openInBrowser(target string) error {
	switch runtime.GOOS {
	case "windows":
		// rundll32 avoids cmd.exe's argument-parsing quirks with URLs.
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	case "darwin":
		return exec.Command("open", target).Start()
	default:
		return exec.Command("xdg-open", target).Start()
	}
}
