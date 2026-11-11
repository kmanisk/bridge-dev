package auth

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type terminalAnswers struct {
	mu           sync.Mutex
	answer       string
	wait         bool
	texts        []string
	active, peak int
}

func (p *terminalAnswers) Available() bool { return true }
func (p *terminalAnswers) Ask(ctx context.Context, text string) (string, error) {
	p.mu.Lock()
	p.texts = append(p.texts, text)
	p.active++
	if p.active > p.peak {
		p.peak = p.active
	}
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.active--; p.mu.Unlock() }()
	if p.wait {
		<-ctx.Done()
		return "", ctx.Err()
	}
	return p.answer, nil
}
func (p *terminalAnswers) Run(context.Context, []string) error { return nil }

type ceremony struct {
	form url.Values
	code string
}

func startCeremony(t *testing.T, o *OAuth, srv *httptest.Server, c *http.Client, id string) ceremony {
	t.Helper()
	q := url.Values{"response_type": {"code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "state": {"state"}, "code_challenge": {Hash(Random())}, "code_challenge_method": {"S256"}, "resource": {o.issuer + "/mcp"}, "scope": {"mcp:user"}}
	r, e := c.Get(srv.URL + "/authorize?" + q.Encode())
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatal(r.StatusCode, string(b))
	}
	hidden := func(name string) string {
		v := regexp.MustCompile(`name="` + name + `" value="([^"]+)"`).FindSubmatch(b)
		if len(v) != 2 {
			t.Fatal(string(b))
		}
		return string(v[1])
	}
	match := regexp.MustCompile(`<strong>([0-9]{6})</strong>`).FindSubmatch(b)
	if len(match) != 2 {
		t.Fatal("missing six-digit code", string(b))
	}
	return ceremony{url.Values{"request_id": {hidden("request_id")}, "csrf": {hidden("csrf")}}, string(match[1])}
}
func pollCeremony(t *testing.T, c *http.Client, srv *httptest.Server, v ceremony) int {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		r, e := c.PostForm(srv.URL+"/authorize", v.form)
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode != 200 {
			return r.StatusCode
		}
		if time.Now().After(deadline) {
			t.Fatal("consent still pending")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestTerminalConsentApproveDenyTimeout(t *testing.T) {
	for _, tc := range []struct {
		name, answer string
		wait         bool
		status       int
	}{{"approve", "y", false, 303}, {"deny", "n", false, 403}, {"timeout", "", true, 403}} {
		t.Run(tc.name, func(t *testing.T) {
			o, srv, c, notice := newOAuthTest(t)
			p := &terminalAnswers{answer: tc.answer, wait: tc.wait}
			o.ConfigureTerminal(context.Background(), prompt.New(p), []string{"127.0.0.1"})
			defer o.Close()
			o.consentTTL = 2 * time.Second
			if tc.wait {
				o.consentTTL = 30 * time.Millisecond
			}
			id := registerTest(t, c, srv.URL)
			v := startCeremony(t, o, srv, c, id)
			if got := pollCeremony(t, c, srv, v); got != tc.status {
				t.Fatal(got)
			}
			p.mu.Lock()
			text := strings.Join(p.texts, "\n")
			p.mu.Unlock()
			if !strings.Contains(text, v.code) || !strings.Contains(text, id) {
				t.Fatal("terminal/browser mismatch")
			}
			if strings.Contains(notice.String(), v.code) {
				t.Fatal("approval code leaked into notices")
			}
			if tc.status == 303 {
				if got := pollCeremony(t, c, srv, v); got != 400 {
					t.Fatal("consent replay", got)
				}
			}
		})
	}
}
func TestConsentRateLimitAndHeadless(t *testing.T) {
	o, srv, c, _ := newOAuthTest(t)
	p := &terminalAnswers{wait: true}
	o.ConfigureTerminal(context.Background(), prompt.New(p), []string{"127.0.0.1"})
	defer o.Close()
	o.consentTTL = 50 * time.Millisecond
	o.rateLimit = 1
	id := registerTest(t, c, srv.URL)
	v := startCeremony(t, o, srv, c, id)
	if got := pollCeremony(t, c, srv, v); got != 403 {
		t.Fatal(got)
	}
	q := url.Values{"response_type": {"code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "state": {"state"}, "code_challenge": {Hash(Random())}, "code_challenge_method": {"S256"}, "resource": {o.issuer + "/mcp"}}
	r, e := c.Get(srv.URL + "/authorize?" + q.Encode())
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 429 {
		t.Fatal(r.StatusCode)
	}
	o.mu.Lock()
	o.prompt = prompt.New(nil)
	o.mu.Unlock()
	r, e = c.Get(srv.URL + "/authorize?" + q.Encode())
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatal(r.StatusCode)
	}
}
func TestIndependentConsentQueueAndRedirects(t *testing.T) {
	o, srv, c, _ := newOAuthTest(t)
	p := &terminalAnswers{wait: true}
	o.ConfigureTerminal(context.Background(), prompt.New(p), []string{"127.0.0.1"})
	defer o.Close()
	o.consentTTL = 50 * time.Millisecond
	one := registerTest(t, c, srv.URL)
	two := registerTest(t, c, srv.URL)
	start := time.Now()
	v1 := startCeremony(t, o, srv, c, one)
	v2 := startCeremony(t, o, srv, c, two)
	if time.Since(start) > time.Second {
		t.Fatal("HTTP blocked for terminal")
	}
	if pollCeremony(t, c, srv, v1) != 403 || pollCeremony(t, c, srv, v2) != 403 {
		t.Fatal("queued timeout")
	}
	p.mu.Lock()
	peak := p.peak
	p.mu.Unlock()
	if peak > 1 {
		t.Fatal("prompts interleaved")
	}
	r, e := c.Post(srv.URL+"/register", "application/json", strings.NewReader(`{"redirect_uris":["https://evil.example/callback"]}`))
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 400 {
		t.Fatal("unapproved redirect host accepted")
	}
}
func TestClientRevocationAndSessions(t *testing.T) {
	o, srv, c, notice := newOAuthTest(t)
	id := registerTest(t, c, srv.URL)
	verifier := Random()
	code := authorizeTest(t, o, srv, c, notice, id, verifier)
	v := tokenTest(t, c, srv.URL, url.Values{"grant_type": {"authorization_code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "resource": {o.issuer + "/mcp"}, "code": {code}, "code_verifier": {verifier}}, 200)
	token := v["access_token"].(string)
	p, e := o.Authenticate(token)
	if e != nil || p.Session == "" || p.Scope != "mcp:user" {
		t.Fatal(p, e)
	}
	clients, e := ListClients(strings.TrimSuffix(o.state, "/oauth"))
	if e != nil || len(clients) != 1 || clients[0].ID != id || clients[0].LastActivity.IsZero() {
		t.Fatal(clients, e)
	}
	if e = RevokeClients(strings.TrimSuffix(o.state, "/oauth"), id, false); e != nil {
		t.Fatal(e)
	}
	if p.Check() == nil {
		t.Fatal("cached authorization survived revoke")
	}
	if _, ok := o.Validate(token); ok {
		t.Fatal("revoked client accepted")
	}
	clients, e = ListClients(strings.TrimSuffix(o.state, "/oauth"))
	if e != nil || !clients[0].Revoked {
		t.Fatal(clients, e)
	}
	if e = RevokeClients(strings.TrimSuffix(o.state, "/oauth"), "", true); e != nil {
		t.Fatal(e)
	}
}

func TestOriginInvalidationAndModeChange(t *testing.T) {
	o, srv, c, notice := newOAuthTest(t)
	id := registerTest(t, c, srv.URL)
	verifier := Random()
	code := authorizeTest(t, o, srv, c, notice, id, verifier)
	v := tokenTest(t, c, srv.URL, url.Values{"grant_type": {"authorization_code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "resource": {o.issuer + "/mcp"}, "code": {code}, "code_verifier": {verifier}}, 200)
	token := v["access_token"].(string)
	p, e := o.Authenticate(token)
	if e != nil {
		t.Fatal(e)
	}
	if e = o.Invalidate(); e != nil {
		t.Fatal(e)
	}
	if p.Check() == nil {
		t.Fatal("stale origin principal remains usable")
	}
	fresh, e := NewOAuth(strings.TrimSuffix(o.state, "/oauth"), o.issuer, "readonly", io.Discard)
	if e != nil {
		t.Fatal(e)
	}
	if _, ok := fresh.Validate(token); ok {
		t.Fatal("old mode token valid")
	}
	listed, e := ListClients(strings.TrimSuffix(o.state, "/oauth"))
	if e != nil || len(listed) != 1 {
		t.Fatal("registration lost", e)
	}
}

func TestPrivilegedTokensExpireWithGrant(t *testing.T) {
	o, srv, c, _ := newOAuthTest(t)
	now := time.Now()
	var clock atomic.Int64
	clock.Store(now.UnixNano())
	var mode atomic.Value
	mode.Store("sudo")
	o.mu.Lock()
	o.now = func() time.Time { return time.Unix(0, clock.Load()) }
	o.scope = "mcp:sudo"
	o.EffectiveMode = func() string { return mode.Load().(string) }
	o.SessionDeadline = now.Add(10 * time.Minute)
	o.mu.Unlock()
	id := registerTest(t, c, srv.URL)
	verifier, code := Random(), Random()
	o.mu.Lock()
	o.db.Codes[Hash(code)] = grant{Client: id, Redirect: "http://127.0.0.1:9999/callback", Challenge: Hash(verifier), Resource: o.issuer + "/mcp", Scope: "mcp:sudo", Expires: now.Add(time.Minute)}
	o.mu.Unlock()
	v := tokenTest(t, c, srv.URL, url.Values{"grant_type": {"authorization_code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "resource": {o.issuer + "/mcp"}, "code": {code}, "code_verifier": {verifier}}, 200)
	if v["expires_in"].(float64) > 600 {
		t.Fatal("token outlives grant")
	}
	p, e := o.Authenticate(v["access_token"].(string))
	if e != nil {
		t.Fatal(e)
	}
	clock.Store(now.Add(11 * time.Minute).UnixNano())
	mode.Store("readonly")
	if p.Check() == nil {
		t.Fatal("expired grant credential accepted")
	}
	tokenTest(t, c, srv.URL, url.Values{"grant_type": {"refresh_token"}, "client_id": {id}, "refresh_token": {v["refresh_token"].(string)}, "resource": {o.issuer + "/mcp"}}, 400)
}

func TestRegistrationBoundIsNotLifetimeQuota(t *testing.T) {
	o, srv, c, _ := newOAuthTest(t)
	o.MaxClients = 1
	id := registerTest(t, c, srv.URL)
	r, e := c.Post(srv.URL+"/register", "application/json", strings.NewReader(`{"redirect_uris":["http://127.0.0.1:9999/callback"]}`))
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 429 {
		t.Fatal("resource bound ignored", r.StatusCode)
	}
	if e = RevokeClients(strings.TrimSuffix(o.state, "/oauth"), id, false); e != nil {
		t.Fatal(e)
	}
	if next := registerTest(t, c, srv.URL); next == id {
		t.Fatal("identity reused")
	}
}
