package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/transport"
)

func authorizeFixture(t *testing.T, hc *http.Client, origin, scope string) string {
	t.Helper()
	hc.Jar, _ = cookiejar.New(nil)
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	r, e := hc.Post(origin+"/register", "application/json", strings.NewReader(`{"redirect_uris":["https://claude.ai/bridge-fixture-callback"],"client_name":"self-reported fixture","token_endpoint_auth_method":"none"}`))
	if e != nil {
		t.Fatal(e)
	}
	var reg map[string]any
	json.NewDecoder(r.Body).Decode(&reg)
	r.Body.Close()
	if r.StatusCode != 201 {
		t.Fatal(r.StatusCode)
	}
	id := reg["client_id"].(string)
	verifier := auth.Random()
	redirect := "https://claude.ai/bridge-fixture-callback"
	q := url.Values{"response_type": {"code"}, "client_id": {id}, "redirect_uri": {redirect}, "state": {"fixture-state"}, "code_challenge": {auth.Hash(verifier)}, "code_challenge_method": {"S256"}, "resource": {origin + "/mcp"}, "scope": {scope}}
	r, e = hc.Get(origin + "/authorize?" + q.Encode())
	if e != nil {
		t.Fatal(e)
	}
	html, _ := io.ReadAll(r.Body)
	r.Body.Close()
	hidden := func(name string) string {
		m := regexp.MustCompile(`name="` + name + `" value="([^"]+)"`).FindSubmatch(html)
		if len(m) != 2 {
			t.Fatal("missing hidden field", name)
		}
		return string(m[1])
	}
	form := url.Values{"request_id": {hidden("request_id")}, "csrf": {hidden("csrf")}}
	for n := 0; n < 100; n++ {
		r, e = hc.PostForm(origin+"/authorize", form)
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode == 303 {
			break
		}
		if r.StatusCode != 200 {
			t.Fatal(r.StatusCode)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if r.StatusCode != 303 {
		t.Fatal("consent not approved")
	}
	u, _ := url.Parse(r.Header.Get("Location"))
	if u.Query().Get("state") != "fixture-state" {
		t.Fatal("state lost")
	}
	r, e = hc.PostForm(origin+"/token", url.Values{"grant_type": {"authorization_code"}, "client_id": {id}, "redirect_uri": {redirect}, "code": {u.Query().Get("code")}, "code_verifier": {verifier}, "resource": {origin + "/mcp"}})
	if e != nil {
		t.Fatal(e)
	}
	var token map[string]any
	json.NewDecoder(r.Body).Decode(&token)
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	return token["access_token"].(string)
}
func TestTunnelRotationInvalidatesCredentialsAndGrant(t *testing.T) {
	dir := private(t)
	bin := t.TempDir()
	marker := filepath.Join(dir, "rotate")
	count := filepath.Join(dir, "count")
	script := "#!/bin/sh\nif test -f '" + count + "'; then echo 'https://second-fixture.trycloudflare.com' >&2; exec /bin/sleep 30; fi\n: > '" + count + "'\necho 'https://first-fixture.trycloudflare.com' >&2\nwhile ! test -f '" + marker + "'; do /bin/sleep 0.01; done\nexit 1\n"
	os.WriteFile(filepath.Join(bin, "cloudflared"), []byte(script), 0700)
	os.WriteFile(filepath.Join(bin, "sudo"), []byte("#!/bin/sh\nexit 99\n"), 0700)
	t.Setenv("PATH", bin)
	c := config.Defaults()
	c.ConfigFile = filepath.Join(dir, "config.toml")
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{t.TempDir()}
	c.OAuth = true
	c.Tunnel = "cloudflared"
	c.Port = 0
	c.Mode = "sudo"
	c.AckPrivileged = true
	if e := config.Save(c); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var output bytes.Buffer
	var local string
	var first *auth.OAuth
	var principal auth.Principal
	ready := 0
	var seen []*proxy
	e := Run(ctx, []string{"--config", c.ConfigFile}, func(string) string { return "" }, prompt.New(&answers{values: []string{"y"}}), &output, transport.Options{RetryBase: time.Millisecond, HealthInterval: time.Second, ClientFactory: func(l string) *http.Client {
		local = l
		p := &proxy{local: l}
		seen = append(seen, p)
		return &http.Client{Transport: p, Timeout: time.Second}
	}, ConfigureOAuth: func(o *auth.OAuth) {
		if first == nil {
			first = o
		}
	}, Ready: func(rt transport.Runtime) {
		ready++
		if ready == 1 {
			hc := &http.Client{Transport: &proxy{local: local}, Timeout: time.Second}
			token := authorizeFixture(t, hc, strings.TrimSuffix(rt.PublicURL, "/mcp"), "mcp:sudo")
			var e error
			principal, e = first.Authenticate(token)
			if e != nil {
				t.Fatal(e)
			}
			os.WriteFile(marker, []byte("rotate"), 0600)
		} else {
			if rt.PublicURL != "https://second-fixture.trycloudflare.com/mcp" || rt.Mode != "readonly" {
				t.Error(rt)
			}
			if principal.Check() == nil {
				t.Error("old origin credential survived")
			}
			cancel()
		}
	}})
	if e != nil || ready != 2 {
		t.Fatal(e, ready, output.String())
	}
	if !strings.Contains(output.String(), "NEW MCP URL") || !strings.Contains(output.String(), "grant revoked") {
		t.Fatal(output.String())
	}
	for _, p := range seen {
		for _, s := range p.seen {
			if strings.Contains(s, "127.0.0.1") || strings.Contains(s, "localhost") {
				t.Fatal("internal advertised URL", s)
			}
		}
	}
}
