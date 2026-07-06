// Package tunnel implements the Go side of the DB Studio local-agent tunnel
// protocol (see AGENT_TUNNEL_PROTOCOL.md). The agent connects outbound over a
// WebSocket to the server and acts as a dumb raw-TCP byte-pipe: the server asks
// it to open TCP connections to host:port reachable from the laptop's network
// and multiplexes many such connections (streams) over the single socket.
package tunnel

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Version reported to the server in the hello frame.
const Version = "1.0.0"

const (
	// dialTimeout is how long we wait for a TCP dial to host:port to succeed.
	dialTimeout = 10 * time.Second

	// tcpReadBuf is the chunk size for reading from a tunneled TCP conn.
	tcpReadBuf = 32 * 1024

	// writeWait is the deadline applied to a single WS write.
	writeWait = 15 * time.Second

	// pongWait is how long we allow between reads before considering the
	// connection dead (the server is expected to be active/keepalive).
	pongWait = 90 * time.Second

	// idlePingInterval is how often we send our own control ping if idle, so a
	// silent connection is detected and to keep intermediaries from timing out.
	idlePingInterval = 30 * time.Second

	// writeChanBuf bounds the outbound frame queue.
	writeChanBuf = 256

	// maxStreams caps the number of concurrent tunneled TCP conns.
	maxStreams = 256
)

// control is a JSON control frame in either direction. Fields are shared across
// message types; only those relevant to a given "t" are populated.
type control struct {
	T             string `json:"t"`
	AgentID       string `json:"agentId,omitempty"`
	RefreshSecret string `json:"refreshSecret,omitempty"`
	StreamID      string `json:"streamId,omitempty"`
	Host          string `json:"host,omitempty"`
	Port          int    `json:"port,omitempty"`
	Error         string `json:"error,omitempty"`
	Hostname      string `json:"hostname,omitempty"`
	OS            string `json:"os,omitempty"`
	Version       string `json:"version,omitempty"`
}

// outFrame is a queued outbound WebSocket message. Exactly one of the control
// path (messageType == TextMessage) or data path (BinaryMessage) is used.
type outFrame struct {
	messageType int
	data        []byte
}

// Result is returned by Run to tell main how the session ended and what to
// persist. The server may hand back an agentId/refreshSecret in the ready frame
// that main should save to config for the next reconnect.
type Result struct {
	AgentID       string
	RefreshSecret string
}

// Client is a single WebSocket session to the server. A fresh Client is created
// for each (re)connection attempt; long-lived reconnect/backoff logic lives in
// main.
type Client struct {
	url   string // full ws/wss URL including ?token=
	token string

	conn *websocket.Conn

	// writeCh serializes ALL websocket writes through one writer goroutine.
	// gorilla/websocket permits only one concurrent writer, so nothing else
	// ever calls conn.Write* directly — everything is enqueued here.
	writeCh chan outFrame

	// streams maps streamId -> the TCP conn for that stream.
	mu      sync.Mutex
	streams map[string]net.Conn

	// ready is closed once the server's ready frame has been processed.
	readyOnce sync.Once
	ready     chan struct{}

	result Result

	// closeOnce guards teardown so it runs exactly once.
	closeOnce sync.Once
}

// New builds a Client for the given server base URL and token. The base URL may
// be ws:// or wss:// (or http/https, which are normalized). The token is either
// a fresh pairing token or the saved refresh secret.
func New(serverURL, token string) (*Client, error) {
	full, err := buildURL(serverURL, token)
	if err != nil {
		return nil, err
	}
	return &Client{
		url:     full,
		token:   token,
		writeCh: make(chan outFrame, writeChanBuf),
		streams: make(map[string]net.Conn),
		ready:   make(chan struct{}),
	}, nil
}

// buildURL normalizes the server URL to a ws:// or wss:// scheme, ensures the
// /agent-ws path, and attaches ?token=<token>.
func buildURL(serverURL, token string) (string, error) {
	s := strings.TrimSpace(serverURL)
	if s == "" {
		return "", errors.New("empty server URL")
	}
	// Allow bare host[:port] with no scheme -> default to wss.
	if !strings.Contains(s, "://") {
		s = "wss://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("parse server URL %q: %w", serverURL, err)
	}
	switch u.Scheme {
	case "wss", "ws":
		// already fine
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported scheme %q (use ws/wss/http/https)", u.Scheme)
	}
	// Set the agent-ws path unless the caller already pointed at a path that
	// looks like the endpoint.
	if u.Path == "" || u.Path == "/" {
		u.Path = "/agent-ws"
	}
	q := u.Query()
	q.Set("token", token)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// Run performs one full session: dial, handshake (hello/ready), then serve
// control+data frames until the connection drops or ctx is cancelled. It always
// tears down every tunneled TCP conn before returning. The returned Result
// carries any agentId/refreshSecret the server assigned (zero-value if none).
func (c *Client) Run(ctx context.Context) (Result, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 20 * time.Second,
	}

	conn, resp, err := dialer.DialContext(ctx, c.url, nil)
	if err != nil {
		if resp != nil {
			return c.result, fmt.Errorf("websocket dial: %w (http %d)", err, resp.StatusCode)
		}
		return c.result, fmt.Errorf("websocket dial: %w", err)
	}
	c.conn = conn
	defer c.teardown()

	// Read deadline + pong handler for gorilla-level keepalive.
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	// Cancelling ctx (Ctrl+C) must unblock the reader: close the conn.
	stopCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		<-stopCtx.Done()
		// Best-effort graceful close, then force the underlying conn shut so
		// ReadMessage returns.
		_ = c.writeCloseMessage()
		_ = c.conn.Close()
	}()

	// Start the single serialized writer.
	writerDone := make(chan struct{})
	go c.writeLoop(writerDone)

	// Idle keepalive pinger.
	go c.pingLoop(stopCtx)

	// Send the hello frame to start the handshake.
	if err := c.sendHello(); err != nil {
		return c.result, fmt.Errorf("send hello: %w", err)
	}

	// Read loop runs on this goroutine until the connection ends.
	readErr := c.readLoop(stopCtx)

	// Stop writer and wait for it to drain/exit.
	c.stopWriter()
	<-writerDone

	return c.result, readErr
}

// sendHello enqueues the initial hello control frame.
func (c *Client) sendHello() error {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown"
	}
	return c.writeControl(control{
		T:        "hello",
		Hostname: host,
		OS:       runtime.GOOS,
		Version:  Version,
	})
}

// readLoop reads frames until an error occurs, dispatching text frames to the
// control handler and binary frames to the data handler.
func (c *Client) readLoop(ctx context.Context) error {
	for {
		mt, data, err := c.conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				// We initiated shutdown; not a real error.
				return nil
			}
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return nil
			}
			return fmt.Errorf("read: %w", err)
		}
		// Any successful read refreshes the liveness deadline.
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))

		switch mt {
		case websocket.TextMessage:
			c.handleControl(data)
		case websocket.BinaryMessage:
			c.handleData(data)
		default:
			// Ignore other frame types.
		}
	}
}

// handleControl parses and dispatches a JSON control frame from the server.
func (c *Client) handleControl(data []byte) {
	var msg control
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("control: bad JSON: %v", err)
		return
	}
	switch msg.T {
	case "ready":
		c.handleReady(msg)
	case "open":
		c.handleOpen(msg)
	case "close":
		c.handleServerClose(msg)
	case "ping":
		if err := c.writeControl(control{T: "pong"}); err != nil {
			log.Printf("control: send pong: %v", err)
		}
	case "pong":
		// Response to our idle ping; liveness already refreshed on read.
	default:
		log.Printf("control: unknown type %q", msg.T)
	}
}

// handleReady records the agentId/refreshSecret the server assigned so main can
// persist them for reconnect, and signals that the session is established.
func (c *Client) handleReady(msg control) {
	if msg.AgentID != "" {
		c.result.AgentID = msg.AgentID
	}
	if msg.RefreshSecret != "" {
		c.result.RefreshSecret = msg.RefreshSecret
	}
	c.readyOnce.Do(func() { close(c.ready) })
	log.Printf("ready: agentId=%s", c.result.AgentID)
}

// handleOpen dials the requested host:port and, on success, starts pumping bytes
// from that TCP conn back to the server as binary frames.
func (c *Client) handleOpen(msg control) {
	streamID := msg.StreamID
	if streamID == "" {
		log.Printf("open: missing streamId")
		return
	}
	addr := net.JoinHostPort(msg.Host, fmt.Sprintf("%d", msg.Port))

	// Enforce the concurrent-stream cap before dialing.
	c.mu.Lock()
	atCap := len(c.streams) >= maxStreams
	c.mu.Unlock()
	if atCap {
		_ = c.writeControl(control{T: "openerr", StreamID: streamID, Error: "too many streams"})
		return
	}

	go func() {
		conn, err := net.DialTimeout("tcp", addr, dialTimeout)
		if err != nil {
			log.Printf("open %s -> %s: dial failed: %v", streamID, addr, err)
			_ = c.writeControl(control{T: "openerr", StreamID: streamID, Error: err.Error()})
			return
		}

		// Register the stream. If one already exists for this id (shouldn't),
		// close the old one first.
		c.mu.Lock()
		if len(c.streams) >= maxStreams {
			c.mu.Unlock()
			_ = conn.Close()
			_ = c.writeControl(control{T: "openerr", StreamID: streamID, Error: "too many streams"})
			return
		}
		if old, ok := c.streams[streamID]; ok {
			_ = old.Close()
		}
		c.streams[streamID] = conn
		c.mu.Unlock()

		if err := c.writeControl(control{T: "opened", StreamID: streamID}); err != nil {
			log.Printf("open %s: send opened failed: %v", streamID, err)
			c.dropStream(streamID)
			return
		}
		log.Printf("opened %s -> %s", streamID, addr)

		c.pumpTCPToServer(streamID, conn)
	}()
}

// pumpTCPToServer reads from the TCP conn and forwards every chunk to the server
// as a binary data frame until EOF/error, then notifies the server with a close
// control frame and drops the stream.
func (c *Client) pumpTCPToServer(streamID string, conn net.Conn) {
	buf := make([]byte, tcpReadBuf)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			if werr := c.writeData(streamID, buf[:n]); werr != nil {
				log.Printf("stream %s: forward to server failed: %v", streamID, werr)
				break
			}
		}
		if err != nil {
			if err != io.EOF && !isClosedConnErr(err) {
				log.Printf("stream %s: tcp read: %v", streamID, err)
			}
			break
		}
	}

	// Tell the server this stream ended, then tear down locally. If the stream
	// was already removed (server-initiated close) skip the notify.
	if c.dropStream(streamID) {
		_ = c.writeControl(control{T: "close", StreamID: streamID})
	}
}

// handleServerClose tears down the TCP conn for a stream the server closed.
func (c *Client) handleServerClose(msg control) {
	if msg.StreamID == "" {
		return
	}
	if c.dropStream(msg.StreamID) {
		log.Printf("close %s (by server)", msg.StreamID)
	}
}

// handleData parses a binary data frame and writes its payload to the matching
// stream's TCP conn.
func (c *Client) handleData(frame []byte) {
	streamID, payload, err := decodeDataFrame(frame)
	if err != nil {
		log.Printf("data: %v", err)
		return
	}
	c.mu.Lock()
	conn := c.streams[streamID]
	c.mu.Unlock()
	if conn == nil {
		// Unknown/closed stream: drop the bytes (server will get its close).
		return
	}
	if _, err := conn.Write(payload); err != nil {
		log.Printf("stream %s: tcp write: %v", streamID, err)
		if c.dropStream(streamID) {
			_ = c.writeControl(control{T: "close", StreamID: streamID})
		}
	}
}

// dropStream removes and closes the TCP conn for streamID. It returns true if a
// stream was actually present and removed (so the caller knows whether to emit a
// close notification).
func (c *Client) dropStream(streamID string) bool {
	c.mu.Lock()
	conn, ok := c.streams[streamID]
	if ok {
		delete(c.streams, streamID)
	}
	c.mu.Unlock()
	if ok && conn != nil {
		_ = conn.Close()
	}
	return ok
}

// writeControl encodes v as JSON and enqueues it as a text frame.
func (c *Client) writeControl(v control) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal control: %w", err)
	}
	return c.enqueue(outFrame{messageType: websocket.TextMessage, data: data})
}

// writeData builds a binary data frame [4-byte BE len][streamId][payload] and
// enqueues it. The payload slice is copied because the caller reuses its buffer.
func (c *Client) writeData(streamID string, payload []byte) error {
	frame := encodeDataFrame(streamID, payload)
	return c.enqueue(outFrame{messageType: websocket.BinaryMessage, data: frame})
}

// enqueue puts a frame on the writer channel, or reports the connection is
// closing if the writer has stopped.
func (c *Client) enqueue(f outFrame) error {
	defer func() {
		// Sending on a closed channel panics; treat that as "closing".
		_ = recover()
	}()
	c.writeCh <- f
	return nil
}

// writeLoop is the ONLY goroutine that writes to the websocket, satisfying
// gorilla's single-writer requirement. It drains writeCh until it is closed.
func (c *Client) writeLoop(done chan struct{}) {
	defer close(done)
	for f := range c.writeCh {
		_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
		if err := c.conn.WriteMessage(f.messageType, f.data); err != nil {
			if !isClosedConnErr(err) {
				log.Printf("write: %v", err)
			}
			// On a write error the connection is dead; force teardown so the
			// read loop unblocks and the session ends.
			_ = c.conn.Close()
			// Keep draining so enqueue() never blocks on a full channel while
			// the session unwinds.
			for range c.writeCh {
			}
			return
		}
	}
}

// stopWriter closes the writer channel exactly once so writeLoop exits.
func (c *Client) stopWriter() {
	c.closeOnce.Do(func() { close(c.writeCh) })
}

// pingLoop sends a control ping if the connection has been idle, providing an
// application-level keepalive in addition to responding to server pings.
func (c *Client) pingLoop(ctx context.Context) {
	t := time.NewTicker(idlePingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			// Best-effort; ignore errors (write loop logs real failures).
			_ = c.writeControl(control{T: "ping"})
		}
	}
}

// writeCloseMessage sends a normal-closure control message directly (used only
// during shutdown, when the writer goroutine may already be gone).
func (c *Client) writeCloseMessage() error {
	if c.conn == nil {
		return nil
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	return c.conn.WriteMessage(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
	)
}

// teardown closes every tunneled TCP conn and the websocket. Safe to call more
// than once.
func (c *Client) teardown() {
	c.mu.Lock()
	conns := make([]net.Conn, 0, len(c.streams))
	for id, conn := range c.streams {
		conns = append(conns, conn)
		delete(c.streams, id)
	}
	c.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
	if c.conn != nil {
		_ = c.conn.Close()
	}
}

// WaitReady blocks until the server's ready frame has been handled or ctx is
// done. Useful for callers that want to know pairing succeeded.
func (c *Client) WaitReady(ctx context.Context) error {
	select {
	case <-c.ready:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// encodeDataFrame builds [4-byte BE streamId length][streamId][payload].
func encodeDataFrame(streamID string, payload []byte) []byte {
	idBytes := []byte(streamID)
	frame := make([]byte, 4+len(idBytes)+len(payload))
	binary.BigEndian.PutUint32(frame[0:4], uint32(len(idBytes)))
	copy(frame[4:], idBytes)
	copy(frame[4+len(idBytes):], payload)
	return frame
}

// decodeDataFrame parses [4-byte BE streamId length][streamId][payload]. The
// returned payload is a sub-slice of frame; the caller writes it out before the
// buffer is reused, so no copy is needed here.
func decodeDataFrame(frame []byte) (streamID string, payload []byte, err error) {
	if len(frame) < 4 {
		return "", nil, fmt.Errorf("short data frame (%d bytes)", len(frame))
	}
	n := binary.BigEndian.Uint32(frame[0:4])
	if int(n) > len(frame)-4 {
		return "", nil, fmt.Errorf("bad streamId length %d in %d-byte frame", n, len(frame))
	}
	streamID = string(frame[4 : 4+n])
	payload = frame[4+n:]
	return streamID, payload, nil
}

// isClosedConnErr reports whether err is the "use of closed network connection"
// class of error we get during normal teardown, so we can silence it.
func isClosedConnErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, net.ErrClosed) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "use of closed network connection") ||
		strings.Contains(msg, "connection reset by peer") ||
		strings.Contains(msg, "broken pipe") ||
		websocket.IsUnexpectedCloseError(err)
}
