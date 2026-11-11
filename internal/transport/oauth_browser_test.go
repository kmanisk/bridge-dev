package transport

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Scripted only: real runtime consent is never approved by a test helper.
type browserConsent struct{ answer string }

func (browserConsent) Available() bool                               { return true }
func (p browserConsent) Ask(context.Context, string) (string, error) { return p.answer, nil }
func (browserConsent) Run(context.Context, []string) error           { return nil }

type browserProxy struct {
	base  string
	inner http.RoundTripper
}

func (p browserProxy) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	u := *r.URL
	local, _ := url.Parse(p.base)
	r.Host = u.Host
	u.Host = local.Host
	u.Scheme = local.Scheme
	r.URL = &u
	return p.inner.RoundTrip(r)
}
func TestBrowserOAuthThroughHTTPGuard(t *testing.T) {
	h, s := handlerTest(t)
	origin := "https://oauth-fixture.trycloudflare.com"
	state := t.TempDir()
	os.Chmod(state, 0700)
	o, e := auth.NewOAuth(state, origin, "readonly", io.Discard)
	if e != nil {
		t.Fatal(e)
	}
	o.ConfigureTerminal(context.Background(), prompt.New(browserConsent{"y"}), []string{"chatgpt.com"})
	t.Cleanup(o.Close)
	h.Bind(origin, o, true)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Transport: browserProxy{s.URL, http.DefaultTransport}, Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	redirect := "https://chatgpt.com/connector_platform_oauth_redirect" // observed real DCR metadata; official stable callback
	resp, e := client.Post(origin+"/register", "application/json", strings.NewReader(`{"redirect_uris":["`+redirect+`"],"client_name":"ChatGPT fixture","token_endpoint_auth_method":"none"}`))
	if e != nil {
		t.Fatal(e)
	}
	var reg struct {
		ID string `json:"client_id"`
	}
	json.NewDecoder(resp.Body).Decode(&reg)
	resp.Body.Close()
	if resp.StatusCode != 201 {
		t.Fatal(resp.StatusCode)
	}
	verifier := auth.Random()
	q := url.Values{"client_id": {reg.ID}, "redirect_uri": {redirect}, "response_type": {"code"}, "state": {"browser-state"}, "code_challenge": {auth.Hash(verifier)}, "code_challenge_method": {"S256"}, "resource": {origin + "/mcp"}, "scope": {"mcp:readonly"}}
	for _, bad := range []string{redirect + "/other", "https://attacker.example/callback"} {
		v := copyValues(q)
		v.Set("redirect_uri", bad)
		r, e := client.Get(origin + "/authorize?" + v.Encode())
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode != 400 {
			t.Fatal("redirect not exact", r.StatusCode)
		}
	}
	req, _ := http.NewRequest("GET", origin+"/authorize?"+q.Encode(), nil)
	req.Host = "untrusted.example"
	localReq := req.Clone(context.Background())
	u := *req.URL
	u.Scheme = "http"
	u.Host = strings.TrimPrefix(s.URL, "http://")
	localReq.URL = &u
	r, e := http.DefaultClient.Do(localReq)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatal("invalid Host accepted")
	}
	// A top-level navigation without Origin must reach consent, not a 403.
	r, e = client.Get(origin + "/authorize?" + q.Encode())
	if e != nil {
		t.Fatal(e)
	}
	html, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || r.Header.Get("Referrer-Policy") != "same-origin" {
		t.Fatal(r.StatusCode, r.Header)
	}
	hidden := func(name string) string {
		m := regexp.MustCompile(`name="` + name + `" value="([^"]+)"`).FindSubmatch(html)
		if len(m) != 2 {
			t.Fatal("missing consent field", name)
		}
		return string(m[1])
	}
	form := url.Values{"request_id": {hidden("request_id")}, "csrf": {hidden("csrf")}}
	post := func(originHeader string, f url.Values) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("POST", origin+"/authorize", strings.NewReader(f.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", originHeader)
		r, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		return r
	}
	for _, bad := range []string{"null", "https://chatgpt.com", "https://attacker.example", origin + "/path", origin + "?query=1", "https://user@oauth-fixture.trycloudflare.com"} {
		if r = post(bad, form); r.StatusCode != 403 {
			t.Fatal("unsafe Origin accepted", bad, r.StatusCode)
		}
	}
	wrong := copyValues(form)
	wrong.Set("csrf", "wrong")
	if r = post(origin, wrong); r.StatusCode != 400 {
		t.Fatal("CSRF accepted")
	}
	for i := 0; i < 100; i++ {
		r = post(origin, form)
		if r.StatusCode == 303 {
			break
		}
		if r.StatusCode != 200 {
			t.Fatal("consent poll failed", r.StatusCode)
		}
		time.Sleep(time.Millisecond)
	}
	if r.StatusCode != 303 {
		t.Fatal("consent never approved")
	}
	callback, _ := url.Parse(r.Header.Get("Location"))
	if callback.Query().Get("state") != "browser-state" || callback.Query().Get("iss") != origin {
		t.Fatal("callback binding lost")
	}
	tokenForm := url.Values{"grant_type": {"authorization_code"}, "client_id": {reg.ID}, "redirect_uri": {redirect}, "code": {callback.Query().Get("code")}, "code_verifier": {"incorrect-but-valid-length-aaaaaaaaaaaaaaaaaaaa"}, "resource": {origin + "/mcp"}}
	r, e = client.PostForm(origin+"/token", tokenForm)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 400 {
		t.Fatal("bad PKCE accepted")
	}
	tokenForm.Set("code_verifier", verifier)
	r, e = client.PostForm(origin+"/token", tokenForm)
	if e != nil {
		t.Fatal(e)
	}
	var token struct {
		Access string `json:"access_token"`
	}
	json.NewDecoder(r.Body).Decode(&token)
	r.Body.Close()
	if r.StatusCode != 200 || token.Access == "" {
		t.Fatal("token exchange failed", r.StatusCode)
	}
	rpc := func(access string) *http.Client {
		return &http.Client{Transport: browserBearer{browserProxy{s.URL, http.DefaultTransport}, access}}
	}
	sdk := mcp.NewClient(&mcp.Implementation{Name: "browser-oauth-fixture", Version: "1"}, nil)
	session, e := sdk.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: origin + "/mcp", HTTPClient: rpc(token.Access), DisableStandaloneSSE: true}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	list, e := session.ListTools(context.Background(), nil)
	if e != nil || len(list.Tools) == 0 {
		t.Fatal(list, e)
	}
	for _, tool := range list.Tools {
		if tool.Name == "exec" || tool.Name == "sudo_exec" {
			t.Fatal("readonly leaked privilege")
		}
	}
	req, _ = http.NewRequest("POST", origin+"/mcp", strings.NewReader(`{}`))
	r, e = client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 401 {
		t.Fatal("unauthenticated MCP accepted")
	}
}

type browserBearer struct {
	inner http.RoundTripper
	token string
}

func (p browserBearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+p.token)
	return p.inner.RoundTrip(r)
}

func copyValues(v url.Values) url.Values {
	out := url.Values{}
	for k, values := range v {
		out[k] = append([]string{}, values...)
	}
	return out
}
