package connect

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/tasks"
	"github.com/kmanisk/bridge-dev/internal/transport"
)

type answers struct {
	values []string
	asked  int
}

func (a *answers) Available() bool { return true }
func (a *answers) Ask(_ context.Context, _ string) (string, error) {
	a.asked++
	if len(a.values) == 0 {
		return "", errors.New("unexpected prompt")
	}
	v := a.values[0]
	a.values = a.values[1:]
	return v, nil
}
func (a *answers) Run(context.Context, []string) error { return nil }
func private(t *testing.T) string                      { t.Helper(); p := t.TempDir(); os.Chmod(p, 0700); return p }
func TestWizardReuseReconfigurePrecedence(t *testing.T) {
	dir := private(t)
	root := t.TempDir()
	cfg := filepath.Join(dir, "config.toml")
	p := &answers{values: []string{root, "readonly", "all", "2m", "none"}}
	args := []string{"--config", cfg, "--tunnel", "none", "--roots", root}
	c, e := Prepare(context.Background(), args, func(string) string { return "" }, prompt.New(p), io.Discard)
	if e != nil || p.asked != 5 || c.Approve != "all" {
		t.Fatal(c, p, e)
	}
	if c.AckPrivileged {
		t.Fatal("wizard wrote ack")
	}
	never := &answers{}
	c, e = Prepare(context.Background(), append(args, "--mode", "user"), func(string) string { return "" }, prompt.New(never), io.Discard)
	if e != nil || never.asked != 0 || c.Mode != "user" {
		t.Fatal(c, e)
	}
	p = &answers{values: []string{"", "readonly", "none", "3m", "none"}}
	c, e = Prepare(context.Background(), append(args, "--reconfigure"), func(string) string { return "" }, prompt.New(p), io.Discard)
	if e != nil || p.asked != 5 || c.Idle != "3m" {
		t.Fatal(c, e)
	}
	got, e := config.Load(args, func(string) string { return "" })
	if e != nil || got.Mode != "readonly" {
		t.Fatal(got, e)
	}
}
func TestDoctorMissingAndClipboardFallback(t *testing.T) {
	c := config.Defaults()
	c.Tunnel = "cloudflared"
	e := Doctor(c, func(string) (string, error) { return "", os.ErrNotExist })
	if e == nil || !strings.Contains(e.Error(), "cloudflared") {
		t.Fatal(e)
	}
	t.Setenv("PATH", t.TempDir())
	if CopyURL(context.Background(), "https://example.com/mcp") {
		t.Fatal("missing clipboard succeeded")
	}
	if InstallHint("darwin", "") != "brew install cloudflared" || !strings.Contains(InstallHint("linux", "ID=cachyos"), "pacman -S") {
		t.Fatal("install instructions")
	}
}
func TestClipboardUsesStdin(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "copied")
	os.WriteFile(filepath.Join(dir, "wl-copy"), []byte("#!/bin/sh\n/bin/cat > '"+target+"'\n"), 0700)
	t.Setenv("PATH", dir)
	if !CopyURL(context.Background(), "https://example.com/mcp") {
		t.Fatal("copy failed")
	}
	b, _ := os.ReadFile(target)
	if string(b) != "https://example.com/mcp" {
		t.Fatal(string(b))
	}
}

type proxy struct {
	local string
	mu    sync.Mutex
	seen  []string
}

func (p *proxy) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	u := *r.URL
	r.Host = u.Host
	p.mu.Lock()
	p.seen = append(p.seen, u.String())
	p.mu.Unlock()
	l, _ := url.Parse(p.local)
	u.Scheme = l.Scheme
	u.Host = l.Host
	r.URL = &u
	resp, e := http.DefaultTransport.RoundTrip(r)
	if e != nil {
		return nil, e
	}
	b, e := io.ReadAll(resp.Body)
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(b))
	p.mu.Lock()
	p.seen = append(p.seen, string(b), resp.Header.Get("WWW-Authenticate"))
	p.mu.Unlock()
	return resp, e
}
func TestConnectFakeTunnelVerifiedPublicMetadata(t *testing.T) {
	dir := private(t)
	root := t.TempDir()
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "cloudflared"), []byte("#!/bin/sh\necho 'https://bridge-fixture.trycloudflare.com' >&2\nexec /bin/sleep 30\n"), 0700)
	t.Setenv("PATH", bin)
	c := config.Defaults()
	c.ConfigFile = filepath.Join(dir, "config.toml")
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{root}
	c.OAuth = true
	c.Tunnel = "cloudflared"
	c.Port = 0
	if e := config.Save(c); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var output bytes.Buffer
	var requests *proxy
	ready := false
	e := Run(ctx, []string{"--config", c.ConfigFile}, func(string) string { return "" }, prompt.New(&answers{}), &output, transport.Options{ClientFactory: func(local string) *http.Client {
		requests = &proxy{local: local}
		return &http.Client{Transport: requests, Timeout: time.Second}
	}, Ready: func(rt transport.Runtime) {
		ready = true
		if rt.PublicURL != "https://bridge-fixture.trycloudflare.com/mcp" {
			t.Error(rt)
		}
		cancel()
	}})
	if e != nil || !ready {
		t.Fatal(e, output.String())
	}
	if !strings.Contains(output.String(), "Bridge connected") || !strings.Contains(output.String(), "Web apps cannot be registered automatically") {
		t.Fatal(output.String())
	}
	for _, u := range requests.seen {
		if strings.Contains(u, "127.0.0.1") || strings.Contains(u, "localhost") {
			t.Fatal(u)
		}
	}
}

func TestUpPrintsVerifiedPublicURL(t *testing.T) {
	dir := private(t)
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "cloudflared"), []byte("#!/bin/sh\necho 'https://up-fixture.trycloudflare.com' >&2\nexec /bin/sleep 30\n"), 0700)
	t.Setenv("PATH", bin)
	c := config.Defaults()
	c.Roots = []string{t.TempDir()}
	c.StateDir = filepath.Join(dir, "state")
	c.OAuth = true
	c.Tunnel = "cloudflared"
	c.Port = 0
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out bytes.Buffer
	e := transport.RunWithOptions(ctx, c, transport.Options{Out: &out, ClientFactory: func(local string) *http.Client {
		return &http.Client{Transport: &proxy{local: local}, Timeout: time.Second}
	}, Ready: func(transport.Runtime) { cancel() }})
	if e != nil || !strings.Contains(out.String(), "https://up-fixture.trycloudflare.com/mcp") {
		t.Fatal(e, out.String())
	}
}

type faultProxy struct {
	local        string
	failuresLeft atomic.Int32
	failureKind  string
}

func (fp *faultProxy) RoundTrip(r *http.Request) (*http.Response, error) {
	if fp.failuresLeft.Add(-1) >= 0 {
		switch fp.failureKind {
		case "conn_refused":
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
		case "dns":
			return nil, &net.DNSError{Err: "no such host", Name: r.URL.Hostname()}
		case "502":
			return &http.Response{
				StatusCode: 502,
				Status:     "502 Bad Gateway",
				Proto:      "HTTP/1.1",
				ProtoMajor: 1,
				ProtoMinor: 1,
				Body:       io.NopCloser(strings.NewReader("bad gateway")),
				Header:     make(http.Header),
			}, nil
		}
	}
	r = r.Clone(r.Context())
	l, _ := url.Parse(fp.local)
	r.URL.Scheme = l.Scheme
	r.URL.Host = l.Host
	r.Host = l.Host
	return http.DefaultTransport.RoundTrip(r)
}

// Requirements C, D, E: Transient connection, DNS, and 502 errors recover via backoff
func TestTransientErrorsRecover(t *testing.T) {
	kinds := []struct {
		name string
		kind string
	}{
		{"HostnameAppearsBeforeReachability", "conn_refused"},
		{"DNSTemporarilyUnavailable", "dns"},
		{"Transient502", "502"},
	}

	for _, tc := range kinds {
		t.Run(tc.name, func(t *testing.T) {
			dir := private(t)
			bin := t.TempDir()
			os.WriteFile(filepath.Join(bin, "cloudflared"), []byte("#!/bin/sh\necho 'https://transient-fixture.trycloudflare.com' >&2\nexec /bin/sleep 30\n"), 0700)
			t.Setenv("PATH", bin)
			c := config.Defaults()
			c.ConfigFile = filepath.Join(dir, "config.toml")
			c.StateDir = filepath.Join(dir, "state")
			c.Roots = []string{t.TempDir()}
			c.OAuth = true
			c.Tunnel = "cloudflared"
			c.Port = 0
			if e := config.Save(c); e != nil {
				t.Fatal(e)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var output bytes.Buffer
			ready := false

			fp := &faultProxy{failureKind: tc.kind}
			fp.failuresLeft.Store(2) // Fail first 2 attempts, succeed on 3rd

			e := Run(ctx, []string{"--config", c.ConfigFile}, func(string) string { return "" }, prompt.New(&answers{}), &output, transport.Options{
				RetryBase: 10 * time.Millisecond,
				ClientFactory: func(local string) *http.Client {
					fp.local = local
					return &http.Client{Transport: fp, Timeout: time.Second}
				},
				Ready: func(rt transport.Runtime) {
					ready = true
					cancel()
				},
			})
			if e != nil || !ready {
				t.Fatalf("test %s failed: err=%v ready=%v output=%s", tc.name, e, ready, output.String())
			}
		})
	}
}

// Requirement N: Retry after failure starts cleanly without stale state
func TestRetryAfterFailureWorksWithoutStaleState(t *testing.T) {
	dir := private(t)
	bin := t.TempDir()
	// Initial failing cloudflared that exits immediately with error
	os.WriteFile(filepath.Join(bin, "cloudflared"), []byte("#!/bin/sh\necho 'fatal edge error' >&2\nexit 1\n"), 0700)
	t.Setenv("PATH", bin)
	c := config.Defaults()
	c.ConfigFile = filepath.Join(dir, "config.toml")
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{t.TempDir()}
	c.OAuth = true
	c.Tunnel = "cloudflared"
	c.Port = 0
	if e := config.Save(c); e != nil {
		t.Fatal(e)
	}

	var output bytes.Buffer
	// First run: must fail
	e := Run(context.Background(), []string{"--config", c.ConfigFile}, func(string) string { return "" }, prompt.New(&answers{}), &output, transport.Options{
		RetryBase: 10 * time.Millisecond,
	})
	if e == nil {
		t.Fatal("expected failure on exiting cloudflared, got nil")
	}
	var ve *transport.VerificationError
	if !errors.As(e, &ve) {
		t.Fatalf("expected VerificationError, got: %T %v", e, e)
	}
	if ve.NetworkErrorCategory != "Tunnel process failure" {
		t.Fatalf("expected Tunnel process failure, got: %s", ve.NetworkErrorCategory)
	}

	// Now fix cloudflared
	os.WriteFile(filepath.Join(bin, "cloudflared"), []byte("#!/bin/sh\necho 'https://retry-fixture.trycloudflare.com' >&2\nexec /bin/sleep 30\n"), 0700)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := false
	output.Reset()

	// Second run: must succeed cleanly without stale lock or state collision
	e = Run(ctx, []string{"--config", c.ConfigFile}, func(string) string { return "" }, prompt.New(&answers{}), &output, transport.Options{
		RetryBase: 10 * time.Millisecond,
		ClientFactory: func(local string) *http.Client {
			return &http.Client{Transport: &proxy{local: local}, Timeout: time.Second}
		},
		Ready: func(rt transport.Runtime) {
			ready = true
			cancel()
		},
	})
	if e != nil || !ready {
		t.Fatalf("second run failed: err=%v ready=%v output=%s", e, ready, output.String())
	}
}

// Requirement P: Durable tasks survive tunnel failure
func TestDurableTasksSurviveTunnelFailure(t *testing.T) {
	dir := private(t)
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "cloudflared"), []byte("#!/bin/sh\nexit 1\n"), 0700)
	t.Setenv("PATH", bin)
	c := config.Defaults()
	c.ConfigFile = filepath.Join(dir, "config.toml")
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{t.TempDir()}
	c.OAuth = true
	c.Tunnel = "cloudflared"
	c.Port = 0
	if e := config.Save(c); e != nil {
		t.Fatal(e)
	}

	// Seed a durable task record in the state dir
	tm, e := tasks.New(c, filepath.Join(bin, "fake-binary"))
	if e != nil {
		t.Fatal(e)
	}
	taskID := tasks.ID()
	taskDir := filepath.Join(tm.Dir, taskID)
	if err := os.MkdirAll(taskDir, 0700); err != nil {
		t.Fatal(err)
	}
	taskFile := filepath.Join(taskDir, "task.json")
	if err := os.WriteFile(taskFile, []byte(`{"id":"`+taskID+`","state":"running"}`), 0600); err != nil {
		t.Fatal(err)
	}

	// Run connect with failing tunnel
	_ = Run(context.Background(), []string{"--config", c.ConfigFile}, func(string) string { return "" }, prompt.New(&answers{}), io.Discard, transport.Options{
		RetryBase: 10 * time.Millisecond,
	})

	// Assert task record survived intact
	data, err := os.ReadFile(taskFile)
	if err != nil {
		t.Fatalf("task record was removed or corrupted: %v", err)
	}
	if !strings.Contains(string(data), taskID) {
		t.Fatalf("task content corrupted: %s", string(data))
	}
}

// Requirement Q: No duplicate tunnel process after retries
func TestNoDuplicateTunnelProcess(t *testing.T) {
	dir := private(t)
	bin := t.TempDir()
	pidDir := t.TempDir()
	script := fmt.Sprintf(`#!/bin/sh
PID=$$
echo $PID >> '%s/pids.txt'
echo 'https://duplicate-check.trycloudflare.com' >&2
exec /bin/sleep 30
`, pidDir)
	os.WriteFile(filepath.Join(bin, "cloudflared"), []byte(script), 0700)
	t.Setenv("PATH", bin)
	c := config.Defaults()
	c.ConfigFile = filepath.Join(dir, "config.toml")
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{t.TempDir()}
	c.OAuth = true
	c.Tunnel = "cloudflared"
	c.Port = 0
	if e := config.Save(c); e != nil {
		t.Fatal(e)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	e := Run(ctx, []string{"--config", c.ConfigFile}, func(string) string { return "" }, prompt.New(&answers{}), io.Discard, transport.Options{
		RetryBase: 10 * time.Millisecond,
		ClientFactory: func(local string) *http.Client {
			return &http.Client{Transport: &proxy{local: local}, Timeout: time.Second}
		},
		Ready: func(rt transport.Runtime) {
			cancel()
		},
	})
	if e != nil {
		t.Fatal(e)
	}

	pidsData, err := os.ReadFile(filepath.Join(pidDir, "pids.txt"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(pidsData)), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected exactly 1 tunnel child launched, got %d: %v", len(lines), lines)
	}
}

func TestWizardRetriesOnlyInvalidField(t *testing.T) {
	dir := private(t)
	root := t.TempDir()
	cfg := filepath.Join(dir, "config.toml")
	p := &answers{values: []string{root + "/missing", root, "yes", "readonly", "maybe", "write", "forever", "2m", "bad", "none"}}
	var out bytes.Buffer
	c, e := Prepare(context.Background(), []string{"--config", cfg, "--tunnel", "none"}, func(string) string { return "" }, prompt.New(p), &out)
	if e != nil || p.asked != 10 || c.Roots[0] != root || c.Mode != "readonly" || c.Idle != "2m" || c.Approve != "write" {
		t.Fatal(c, e, out.String())
	}
	for _, message := range []string{"invalid roots", "invalid mode", "invalid approval", "invalid idle", "invalid tunnel"} {
		if !strings.Contains(out.String(), message) {
			t.Fatal("missing field guidance", message)
		}
	}
}

func TestConnectPreservesExistingPartialInstance(t *testing.T) {
	dir := private(t)
	c := config.Defaults()
	c.ConfigFile = filepath.Join(dir, "config.toml")
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{t.TempDir()}
	c.Tunnel = "none"
	if e := config.Save(c); e != nil {
		t.Fatal(e)
	}
	if e := platform.PrivateDir(c.StateDir); e != nil {
		t.Fatal(e)
	}
	unlock, e := platform.TryLock(filepath.Join(c.StateDir, "http.lock"))
	if e != nil {
		t.Fatal(e)
	}
	defer unlock()
	p := &answers{}
	var out bytes.Buffer
	e = Run(context.Background(), []string{"--config", c.ConfigFile, "--reconfigure"}, func(string) string { return "" }, prompt.New(p), &out, transport.Options{})
	if e == nil || p.asked != 0 || !strings.Contains(e.Error(), "existing session preserved") || !strings.Contains(out.String(), "partial") {
		t.Fatal(e, p.asked, out.String())
	}
}
