// Package transport implements authenticated, bounded loopback HTTP hosting.
package transport

import (
	"context"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/audit"
	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/mcpserver"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/tunnel"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

type Runtime struct {
	URL      string `json:"url"`
	PID      int    `json:"pid"`
	Identity string `json:"identity"`
	Mode     string `json:"mode"`
	Probe    bool   `json:"probe"`
}
type Handler struct {
	mcpHandler http.Handler
	App        *mcpserver.App
	Token      string
	Host       string
	Issuer     string
	Stop       context.CancelFunc
	Active     atomic.Int64
	Last       atomic.Int64
	sem        chan struct{}
	OAuth      *auth.OAuth
}

func NewHandler(a *mcpserver.App, token, host, issuer string, stop context.CancelFunc) *Handler {
	h := &Handler{App: a, Token: token, Host: host, Issuer: issuer, Stop: stop, sem: make(chan struct{}, 16)}
	h.Last.Store(time.Now().UnixNano())
	h.mcpHandler = mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server { return a.Server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 2 << 20, PropagateRequestCancellation: true, DisableLocalhostProtection: issuer != ""})
	return h
}
func (h *Handler) MCP() http.Handler { return h.mcpHandler }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	issuerHost := ""
	if u, e := url.Parse(h.Issuer); e == nil {
		issuerHost = u.Host
	}
	if r.Host != h.Host && (issuerHost == "" || r.Host != issuerHost) {
		http.Error(w, "invalid host", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+h.Host && origin != h.Issuer {
		http.Error(w, "invalid origin", http.StatusForbidden)
		return
	}
	if r.URL.Query().Has("access_token") {
		http.Error(w, "URL tokens forbidden", 400)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if r.URL.Path == "/healthz" {
		if r.Method != http.MethodGet {
			w.WriteHeader(405)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
		return
	}
	select {
	case h.sem <- struct{}{}:
		defer func() { <-h.sem }()
	default:
		http.Error(w, "busy", http.StatusTooManyRequests)
		return
	}
	if h.OAuth != nil && h.OAuth.IsEndpoint(r.URL.Path) {
		h.Active.Add(1)
		defer func() { h.Last.Store(time.Now().UnixNano()); h.Active.Add(-1) }()
		h.OAuth.ServeHTTP(w, r)
		return
	}
	if r.URL.Path != "/mcp" && r.URL.Path != "/_shutdown" {
		http.NotFound(w, r)
		return
	}
	bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	id := ""
	valid := false
	if r.URL.Path == "/_shutdown" || h.OAuth == nil {
		valid = strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && auth.Equal(bearer, h.Token)
		id = "local-bearer"
	} else if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		id, valid = h.OAuth.Validate(bearer)
	}
	if !valid {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, h.BaseURL())+fmt.Sprintf(`, scope="mcp:%s"`, h.App.Config.Mode))
		_ = h.App.Audit.Write(audit.Record{Client: "unauthenticated", Operation: "http_auth", Mode: string(h.App.Config.Mode), Allowed: false})
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/_shutdown" {
		if r.Host != h.Host {
			http.Error(w, "local administration only", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(405)
			return
		}
		w.WriteHeader(202)
		h.Stop()
		return
	}
	h.Active.Add(1)
	defer func() { h.Last.Store(time.Now().UnixNano()); h.Active.Add(-1) }()
	h.MCP().ServeHTTP(w, r.WithContext(auth.WithClient(r.Context(), id)))
}
func (h *Handler) BaseURL() string {
	if h.Issuer != "" {
		return h.Issuer
	}
	return "http://" + h.Host
}
func (h *Handler) Idle(ctx context.Context, d time.Duration) {
	interval := min(d/4, time.Second)
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if h.Active.Load() == 0 && time.Since(time.Unix(0, h.Last.Load())) >= d {
				h.Stop()
				return
			}
		}
	}
}
func Run(ctx context.Context, c config.Config) error {
	if e := c.Validate(true); e != nil {
		return e
	}
	if e := platform.PrivateDir(c.StateDir); e != nil {
		return e
	}
	unlock, e := platform.TryLock(filepath.Join(c.StateDir, "http.lock"))
	if e != nil {
		return errors.New("an HTTP instance already owns this state directory")
	}
	defer unlock()
	token, e := auth.LocalToken(c.StateDir)
	if e != nil {
		return e
	}
	a, e := mcpserver.New(c, true)
	if e != nil {
		return e
	}
	defer a.Close()
	l, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", c.Port))
	if e != nil {
		return e
	}
	defer l.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	host := l.Addr().String()
	if c.Tunnel == "cloudflared" {
		t, e := tunnel.Start(ctx, "cloudflared", "http://"+host)
		if e != nil {
			return e
		}
		defer t.Close()
		c.Issuer = t.URL
		fmt.Fprintf(os.Stderr, "Quick Tunnel MCP URL: %s/mcp; reconnect clients after URL changes\n", t.URL)
	}
	h := NewHandler(a, token, host, c.Issuer, cancel)
	if c.OAuth {
		o, e := auth.NewOAuth(c.StateDir, h.BaseURL(), string(c.Mode), os.Stderr)
		if e != nil {
			return e
		}
		h.OAuth = o
	}

	pid := os.Getpid()
	ident, e := platform.ProcessIdentity(pid)
	if e != nil {
		return e
	}
	rt := Runtime{URL: "http://" + host, PID: pid, Identity: ident, Mode: string(c.Mode), Probe: c.Probe}
	p := filepath.Join(c.StateDir, "http.json")
	if e = platform.AtomicJSON(p, rt); e != nil {
		return e
	}
	defer os.Remove(p)
	fmt.Fprintf(os.Stderr, "%s/mcp (mode=%s, probe=%t); token file: %s\n", rt.URL, c.Mode, c.Probe, filepath.Join(c.StateDir, "token"))
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 11 * time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(l) }()
	d, _ := time.ParseDuration(c.Idle)
	go h.Idle(ctx, d)
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 11*time.Minute)
		defer cancel()
		return srv.Shutdown(shutdown)
	case e := <-done:
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	}
}
func Status(c config.Config) (Runtime, error) {
	var rt Runtime
	e := platform.ReadJSON(filepath.Join(c.StateDir, "http.json"), &rt)
	if e != nil {
		return rt, e
	}
	id, e := platform.ProcessIdentity(rt.PID)
	if e != nil || id != rt.Identity {
		return rt, errors.New("HTTP instance is not running (stale runtime record)")
	}
	return rt, nil
}
func Down(ctx context.Context, c config.Config) error {
	rt, e := Status(c)
	if e != nil {
		return e
	}
	u, e := url.Parse(rt.URL)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		return errors.New("invalid runtime URL")
	}
	token, e := auth.LocalToken(c.StateDir)
	if e != nil {
		return e
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, rt.URL+"/_shutdown", nil)
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, e := client.Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 202 {
		return fmt.Errorf("shutdown refused: %d", resp.StatusCode)
	}
	return nil
}
