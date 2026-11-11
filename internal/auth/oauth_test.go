package auth

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func newOAuthTest(t *testing.T) (*OAuth, *httptest.Server, *http.Client, *bytes.Buffer) {
	t.Helper()
	state := t.TempDir()
	os.Chmod(state, 0700)
	var notice bytes.Buffer
	o, e := NewOAuth(state, "http://127.0.0.1:1234", "user", &notice)
	if e != nil {
		t.Fatal(e)
	}
	srv := httptest.NewServer(o)
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return o, srv, client, &notice
}
func registerTest(t *testing.T, c *http.Client, base string) string {
	t.Helper()
	r, e := c.Post(base+"/register", "application/json", strings.NewReader(`{"redirect_uris":["http://127.0.0.1:9999/callback"],"client_name":"test","token_endpoint_auth_method":"none"}`))
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	var v map[string]any
	json.NewDecoder(r.Body).Decode(&v)
	if r.StatusCode != 201 {
		t.Fatal(r.StatusCode, v)
	}
	return v["client_id"].(string)
}
func authorizeTest(t *testing.T, o *OAuth, srv *httptest.Server, c *http.Client, notice *bytes.Buffer, id, verifier string) string {
	t.Helper()
	q := url.Values{"response_type": {"code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "state": {"csrf-client-state"}, "code_challenge": {Hash(verifier)}, "code_challenge_method": {"S256"}, "resource": {o.issuer + "/mcp"}, "scope": {"mcp:user"}}
	r, e := c.Get(srv.URL + "/authorize?" + q.Encode())
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatal(r.StatusCode, string(body))
	}
	idMatch := regexp.MustCompile(`name="request_id" value="([^"]+)"`).FindSubmatch(body)
	csrfMatch := regexp.MustCompile(`name="csrf" value="([^"]+)"`).FindSubmatch(body)
	consent := regexp.MustCompile(`code \(2 minutes\): ([A-Za-z0-9_-]+)`).FindAllStringSubmatch(notice.String(), -1)
	if len(idMatch) == 0 || len(csrfMatch) == 0 || len(consent) == 0 {
		t.Fatal(string(body), notice.String())
	}
	form := url.Values{"request_id": {string(idMatch[1])}, "csrf": {string(csrfMatch[1])}, "consent_code": {consent[len(consent)-1][1]}, "decision": {"approve"}}
	r, e = c.PostForm(srv.URL+"/authorize", form)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 303 {
		t.Fatal(r.StatusCode)
	}
	u, _ := url.Parse(r.Header.Get("Location"))
	if u.Host != "127.0.0.1:9999" || u.Query().Get("state") != "csrf-client-state" || u.Query().Get("iss") != o.issuer {
		t.Fatal(u)
	}
	return u.Query().Get("code")
}
func tokenTest(t *testing.T, c *http.Client, base string, q url.Values, status int) map[string]any {
	t.Helper()
	r, e := c.PostForm(base+"/token", q)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	var v map[string]any
	json.NewDecoder(r.Body).Decode(&v)
	if r.StatusCode != status {
		t.Fatal(r.StatusCode, v)
	}
	return v
}
func TestOAuthPKCERefreshRevocation(t *testing.T) {
	o, srv, c, notice := newOAuthTest(t)
	id := registerTest(t, c, srv.URL)
	verifier := Random()
	code := authorizeTest(t, o, srv, c, notice, id, verifier)
	q := url.Values{"grant_type": {"authorization_code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "resource": {o.issuer + "/mcp"}, "code": {code}, "code_verifier": {Random()}}
	tokenTest(t, c, srv.URL, q, 400)
	q.Set("code_verifier", verifier)
	v := tokenTest(t, c, srv.URL, q, 200)
	tokenTest(t, c, srv.URL, q, 400)
	access, refresh := v["access_token"].(string), v["refresh_token"].(string)
	if got, ok := o.Validate(access); !ok || got != id {
		t.Fatal(got, ok)
	}
	if _, ok := o.Validate("wrong"); ok {
		t.Fatal("bad token")
	}
	stored, _ := os.ReadFile(filepath.Join(o.state, "store.json"))
	if bytes.Contains(stored, []byte(access)) || bytes.Contains(stored, []byte(refresh)) {
		t.Fatal("raw credentials persisted")
	}
	reloaded, e := NewOAuth(filepath.Dir(o.state), o.issuer, "user", io.Discard)
	if e != nil {
		t.Fatal(e)
	}
	if _, ok := reloaded.Validate(access); !ok {
		t.Fatal("restart lost credential")
	}
	f := url.Values{"grant_type": {"refresh_token"}, "client_id": {id}, "refresh_token": {refresh}, "resource": {o.issuer + "/mcp"}}
	v = tokenTest(t, c, srv.URL, f, 200)
	newAccess := v["access_token"].(string)
	tokenTest(t, c, srv.URL, f, 400)
	if _, ok := o.Validate(newAccess); ok {
		t.Fatal("replay did not revoke family")
	}
	code = authorizeTest(t, o, srv, c, notice, id, verifier)
	q.Set("code", code)
	v = tokenTest(t, c, srv.URL, q, 200)
	access = v["access_token"].(string)
	r, e := c.PostForm(srv.URL+"/revoke", url.Values{"client_id": {id}, "token": {access}})
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if _, ok := o.Validate(access); ok {
		t.Fatal("revoked")
	}
	code = authorizeTest(t, o, srv, c, notice, id, verifier)
	q.Set("code", code)
	v = tokenTest(t, c, srv.URL, q, 200)
	access = v["access_token"].(string)
	o.mu.Lock()
	o.now = func() time.Time { return time.Now().Add(16 * time.Minute) }
	o.mu.Unlock()
	if _, ok := o.Validate(access); ok {
		t.Fatal("expired token")
	}
}
func TestOAuthRejectsInvalid(t *testing.T) {
	o, srv, c, _ := newOAuthTest(t)
	id := registerTest(t, c, srv.URL)
	for _, query := range []url.Values{{"client_id": {id}, "redirect_uri": {"https://evil.example/cb"}}, {"client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "response_type": {"code"}, "code_challenge_method": {"plain"}}} {
		r, e := c.Get(srv.URL + "/authorize?" + query.Encode())
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode != 400 || r.Header.Get("Location") != "" {
			t.Fatal(r.StatusCode)
		}
	}
	r, e := c.PostForm(srv.URL+"/authorize", url.Values{"request_id": {"fake"}, "csrf": {"fake"}})
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 400 {
		t.Fatal(r.StatusCode)
	}
	for _, p := range []string{"/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"} {
		r, e = c.Get(srv.URL + p)
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode != 200 {
			t.Fatal(p, r.StatusCode)
		}
	}
	if _, e = NewOAuth(filepath.Dir(o.state), "https://changed.example", "user", io.Discard); e == nil {
		t.Fatal("issuer changed silently")
	}
	for _, u := range []string{"http://example.org", "https://example.org/path", "https://user@example.org"} {
		if _, e = NewOAuth(t.TempDir(), u, "readonly", io.Discard); e == nil {
			t.Fatal(u)
		}
	}
}
func TestLocalToken(t *testing.T) {
	s := t.TempDir()
	os.Chmod(s, 0700)
	a, e := LocalToken(s)
	if e != nil || len(a) != 43 {
		t.Fatal(a, e)
	}
	b, e := LocalToken(s)
	if e != nil || !Equal(a, b) {
		t.Fatal(e)
	}
	os.Chmod(filepath.Join(s, "token"), 0644)
	if _, e = LocalToken(s); e == nil {
		t.Fatal("public token file")
	}
}

func TestConfidentialRegistration(t *testing.T) {
	o, srv, c, _ := newOAuthTest(t)
	r, e := c.Post(srv.URL+"/register", "application/json", strings.NewReader(`{"redirect_uris":["https://client.example/callback"],"token_endpoint_auth_method":"client_secret_basic"}`))
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	var v map[string]any
	json.NewDecoder(r.Body).Decode(&v)
	if r.StatusCode != 201 {
		t.Fatal(v)
	}
	id, secret := v["client_id"].(string), v["client_secret"].(string)
	stored, _ := os.ReadFile(filepath.Join(o.state, "store.json"))
	if bytes.Contains(stored, []byte(secret)) {
		t.Fatal("client secret persisted raw")
	}
	request := func(password string) int {
		req, _ := http.NewRequest("POST", srv.URL+"/token", strings.NewReader("grant_type=authorization_code&code=invalid&resource="+url.QueryEscape(o.issuer+"/mcp")))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.SetBasicAuth(url.QueryEscape(id), url.QueryEscape(password))
		resp, e := c.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if request("wrong") != 401 || request(secret) != 400 {
		t.Fatal("confidential authentication")
	}
}
