package connect

import (
	"bytes"
	"context"
	"errors"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/transport"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
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
