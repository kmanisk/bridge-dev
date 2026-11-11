// Package transport implements authenticated, bounded loopback HTTP hosting.
package transport

import (
	"context"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/audit"
	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/events"
	"github.com/kmanisk/bridge-dev/internal/mcpserver"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/tunnel"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Runtime struct {
	PublicURL string `json:"public_mcp_url,omitempty"`
	Tunnel    string `json:"tunnel,omitempty"`
	URL       string `json:"url"`
	PID       int    `json:"pid"`
	Identity  string `json:"identity"`
	Mode      string `json:"mode"`
	Probe     bool   `json:"probe"`
}
type binding struct {
	Origin   string
	OAuth    *auth.OAuth
	Verified bool
}
type Handler struct {
	hostDenied atomic.Int64
	binding    atomic.Pointer[binding]
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
	h.mcpHandler = mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server { return a.Server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 2 << 20, PropagateRequestCancellation: true, DisableLocalhostProtection: true})
	return h
}
func (h *Handler) MCP() http.Handler { return h.mcpHandler }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	bound := h.snapshot()
	issuer, oauth := bound.Origin, bound.OAuth
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	issuerHost := ""
	if u, e := url.Parse(issuer); e == nil {
		issuerHost = u.Host
	}
	if r.Host != h.Host && (issuerHost == "" || r.Host != issuerHost) {
		previous := h.hostDenied.Load()
		if time.Now().Unix()-previous >= 10 && h.hostDenied.CompareAndSwap(previous, time.Now().Unix()) {
			_ = h.App.Audit.Write(audit.Record{Client: "unauthenticated", Operation: "http_host", Mode: string(h.App.Config.Mode), Phase: "denied", Reason: "invalid_request"})
		}
		http.Error(w, "invalid host", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+h.Host && origin != issuer {
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
	if oauth != nil && oauth.IsEndpoint(r.URL.Path) {
		h.Active.Add(1)
		defer func() { h.Last.Store(time.Now().UnixNano()); h.Active.Add(-1) }()
		oauth.ServeHTTP(w, r)
		return
	}
	if r.URL.Path != "/mcp" && r.URL.Path != "/_shutdown" {
		http.NotFound(w, r)
		return
	}
	bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	id := ""
	var principal auth.Principal
	valid := false
	if r.URL.Path == "/_shutdown" || oauth == nil {
		valid = strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && auth.Equal(bearer, h.Token)
		id = "local-bearer"
	} else if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		var e error
		principal, e = oauth.Authenticate(bearer)
		id = principal.ID
		valid = e == nil
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
	if !bound.Verified {
		http.Error(w, "origin verification pending", http.StatusServiceUnavailable)
		return
	}
	if principal.ID == "" {
		principal = auth.Principal{ID: id, Session: "local-bearer", Scope: "mcp:" + string(h.App.Config.Mode), Origin: h.BaseURL(), Authenticated: true, Check: func() error { return nil }}
	}
	h.Active.Add(1)
	defer func() { h.Last.Store(time.Now().UnixNano()); h.Active.Add(-1) }()
	principal.CallDeadline = time.Now().Add(24 * time.Second)
	http.TimeoutHandler(h.MCP(), 25*time.Second, "request timeout; poll with the same request_key").ServeHTTP(w, r.WithContext(auth.WithPrincipal(r.Context(), principal)))
}
func (h *Handler) snapshot() binding {
	if b := h.binding.Load(); b != nil {
		return *b
	}
	return binding{Origin: h.Issuer, OAuth: h.OAuth, Verified: true}
}
func (h *Handler) Bind(origin string, o *auth.OAuth, verified bool) {
	h.binding.Store(&binding{origin, o, verified})
}
func (h *Handler) BaseURL() string {
	if v := h.snapshot().Origin; v != "" {
		return v
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

type Options struct {
	Prompts        *prompt.Coordinator
	Out            io.Writer
	Connect        bool
	ClientFactory  func(local string) *http.Client
	ConfigureOAuth func(*auth.OAuth)
	Ready          func(Runtime)
}

func Run(ctx context.Context, c config.Config) error { return RunWithOptions(ctx, c, Options{}) }
func RunWithOptions(ctx context.Context, c config.Config, opt Options) error {
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
	out := opt.Out
	if out == nil {
		out = os.Stderr
	}
	out = &events.Writer{Out: out}
	var outMu sync.Mutex
	emit := func(format string, args ...any) {
		outMu.Lock()
		defer outMu.Unlock()
		fmt.Fprintf(out, format, args...)
	}
	token, e := auth.LocalToken(c.StateDir)
	if e != nil {
		return e
	}
	a, e := mcpserver.New(c, true)
	if e != nil {
		return e
	}
	defer a.Close()
	if e = a.ConfigurePrompts(ctx, opt.Prompts); e != nil {
		return e
	}
	if opt.Connect {
		a.Events = events.New(string(c.Mode), out)
	}
	l, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", c.Port))
	if e != nil {
		return e
	}
	defer l.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var background sync.WaitGroup
	defer func() { cancel(); background.Wait() }()
	host := l.Addr().String()
	local := "http://" + host
	h := NewHandler(a, token, host, "", cancel)
	h.Bind("", nil, false)
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 11 * time.Minute, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(l) }()
	defer func() {
		shutdown, stop := context.WithTimeout(context.Background(), 11*time.Minute)
		defer stop()
		_ = srv.Shutdown(shutdown)
	}()
	origin := c.Issuer
	if origin == "" {
		origin = local
	}
	var owned *tunnel.Tunnel
	if c.Tunnel != "none" {
		owned, e = tunnel.StartProvider(ctx, c, local)
		if e != nil {
			return e
		}
		defer owned.Close()
		origin = owned.URL
		if e = tunnel.ValidateOrigin(origin); e != nil {
			return e
		}
	}
	oauthState := c.StateDir
	if origin != local {
		if e = platform.PrivateDir(filepath.Join(c.StateDir, "origins")); e != nil {
			return e
		}
		oauthState = filepath.Join(c.StateDir, "origins", auth.Hash(origin))
		if e = platform.PrivateDir(oauthState); e != nil {
			return e
		}
	}
	var o *auth.OAuth
	if c.OAuth {
		o, e = auth.NewOAuth(oauthState, origin, string(c.Mode), out)
		if e != nil {
			return e
		}
		if c.Auth == "oauth" {
			o.ConfigureTerminal(ctx, opt.Prompts, c.RedirectHosts)
		} else {
			o.ConfigureCode(c.RedirectHosts)
		}
		o.OnConsent = func(client, status string) error {
			a.Events.Emit("OAuth consent " + status + " for " + client)
			return a.Audit.Write(audit.Record{Client: client, Operation: "oauth_consent", Mode: string(c.Mode), Phase: status, Allowed: status == "approved"})
		}
		defer o.Close()
		if opt.ConfigureOAuth != nil {
			opt.ConfigureOAuth(o)
		}
	}
	h.Bind(origin, o, false)
	if opt.Connect || origin != local {
		client := VerificationClient()
		if opt.ClientFactory != nil {
			client = opt.ClientFactory(local)
		}
		deadline := time.NewTimer(30 * time.Second)
		defer deadline.Stop()
		for {
			e = VerifyEndpoint(ctx, client, origin)
			if e == nil {
				break
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-deadline.C:
				return fmt.Errorf("endpoint verification failed: %w", e)
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
	h.Bind(origin, o, true)
	pid := os.Getpid()
	ident, e := platform.ProcessIdentity(pid)
	if e != nil {
		return e
	}
	rt := Runtime{URL: local, PID: pid, Identity: ident, Mode: string(c.Mode), Probe: c.Probe, PublicURL: origin + "/mcp", Tunnel: c.Tunnel}
	p := filepath.Join(c.StateDir, "http.json")
	if e = platform.AtomicJSON(p, rt); e != nil {
		return e
	}
	defer os.Remove(p)
	if opt.Connect {
		emit("Bridge connected\nMode: %s\nMCP URL: %s/mcp\nAuthentication: OAuth\nTunnel: %s\n", c.Mode, origin, c.Tunnel)
		if c.Tunnel != "none" {
			emit("Temporary URL: reconnect your AI apps after URL changes.\n")
		}
	} else {
		emit("%s/mcp (mode=%s, probe=%t); token file: %s\n", local, c.Mode, c.Probe, filepath.Join(c.StateDir, "token"))
	}
	if opt.Ready != nil {
		opt.Ready(rt)
	}
	d, _ := time.ParseDuration(c.Idle)
	background.Add(1)
	go func() { defer background.Done(); h.Idle(ctx, d) }()
	if opt.Connect {
		background.Add(1)
		go func() {
			defer background.Done()
			cursor := ""
			initial := true
			warned := false
			tick := time.NewTicker(time.Second)
			defer tick.Stop()
			for {
				ev, e := a.Tasks.Events(cursor)
				if e == nil {
					for _, v := range ev {
						cursor = v.Cursor
						if !initial {
							code := "unknown"
							if v.ExitCode != nil {
								code = fmt.Sprint(*v.ExitCode)
							}
							a.Events.Emit(fmt.Sprintf("Task %s %s (exit %s)", v.ID, v.State, code))
						}
					}
				}
				if len(ev) < 20 {
					initial = false
				}
				remaining := d - time.Since(time.Unix(0, h.Last.Load()))
				if remaining <= min(2*time.Minute, d/5) && !warned {
					a.Events.Emit("Idle shutdown approaching")
					warned = true
				}
				if remaining > d/2 {
					warned = false
				}
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
				}
			}
		}()
	}

	var tunnelDone <-chan struct{}
	if owned != nil {
		tunnelDone = owned.Done()
	}
	select {
	case <-ctx.Done():
		emit("Graceful shutdown (mode=%s); durable tasks continue.\n", c.Mode)
		return nil
	case <-tunnelDone:
		return errors.New("owned tunnel disconnected; reconnect required")
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
