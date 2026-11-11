// Package auth provides local tokens and a single-user OAuth authorization
// server implementing authorization code + S256 PKCE, resource binding,
// rotating refresh tokens, RFC 7591 registration and RFC 7009 revocation.
package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const accessLifetime = 15 * time.Minute
const refreshLifetime = 7 * 24 * time.Hour

type client struct {
	SecretHash string   `json:"secret_hash,omitempty"`
	ID         string   `json:"client_id"`
	Redirects  []string `json:"redirect_uris"`
	Name       string   `json:"client_name"`
	Method     string   `json:"token_endpoint_auth_method"`
}
type pending struct {
	Client      string
	Redirect    string
	State       string
	Challenge   string
	Resource    string
	Scope       string
	ConsentHash string
	CSRFHash    string
	CookieHash  string
	Expires     time.Time
	Attempts    int
}
type grant struct {
	Client    string
	Redirect  string
	Challenge string
	Resource  string
	Scope     string
	Expires   time.Time
}
type credential struct {
	Client   string
	Resource string
	Scope    string
	Family   string
	Expires  time.Time
	Used     bool
}
type database struct {
	Issuer  string
	Mode    string
	Clients map[string]client
	Pending map[string]pending
	Codes   map[string]grant
	Access  map[string]credential
	Refresh map[string]credential
	Revoked map[string]bool
}
type OAuth struct {
	mu     sync.Mutex
	state  string
	issuer string
	scope  string
	notice io.Writer
	db     database
	now    func() time.Time
}

func NewOAuth(state, issuer, mode string, notice io.Writer) (*OAuth, error) {
	u, e := url.Parse(issuer)
	if e != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, errors.New("issuer must be an origin URL")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback(u.Hostname())) {
		return nil, errors.New("OAuth issuer requires HTTPS (HTTP loopback only for development)")
	}
	if mode != "readonly" && mode != "user" {
		return nil, errors.New("OAuth forbids privileged modes")
	}
	dir := filepath.Join(state, "oauth")
	if e = platform.PrivateDir(dir); e != nil {
		return nil, e
	}
	o := &OAuth{state: dir, issuer: issuer, scope: "mcp:" + mode, notice: notice, now: time.Now}
	e = platform.ReadJSON(filepath.Join(dir, "store.json"), &o.db)
	if e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	if e != nil {
		o.db = database{Issuer: issuer, Mode: mode, Clients: map[string]client{}, Pending: map[string]pending{}, Codes: map[string]grant{}, Access: map[string]credential{}, Refresh: map[string]credential{}, Revoked: map[string]bool{}}
	} else if o.db.Issuer != issuer || o.db.Mode != mode {
		return nil, errors.New("stored OAuth issuer/mode mismatch; use a fresh state directory or explicitly archive old OAuth state")
	}
	return o, o.save()
}
func loopback(h string) bool {
	ip := net.ParseIP(h)
	return h == "localhost" || ip != nil && ip.IsLoopback()
}
func (o *OAuth) save() error { return platform.AtomicJSON(filepath.Join(o.state, "store.json"), o.db) }
func (o *OAuth) IsEndpoint(p string) bool {
	return slices.Contains([]string{"/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/register", "/authorize", "/token", "/revoke"}, p)
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func oauthError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
func (o *OAuth) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	o.mu.Lock()
	defer o.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'")
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	switch r.URL.Path {
	case "/.well-known/oauth-authorization-server":
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		writeJSON(w, 200, map[string]any{"issuer": o.issuer, "authorization_endpoint": o.issuer + "/authorize", "token_endpoint": o.issuer + "/token", "registration_endpoint": o.issuer + "/register", "revocation_endpoint": o.issuer + "/revoke", "response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code", "refresh_token"}, "code_challenge_methods_supported": []string{"S256"}, "token_endpoint_auth_methods_supported": []string{"none", "client_secret_basic"}, "authorization_response_iss_parameter_supported": true, "scopes_supported": []string{o.scope}, "client_id_metadata_document_supported": false})
	case "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp":
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		writeJSON(w, 200, map[string]any{"resource": o.issuer + "/mcp", "authorization_servers": []string{o.issuer}, "scopes_supported": []string{o.scope}, "bearer_methods_supported": []string{"header"}})
	case "/register":
		o.register(w, r)
	case "/authorize":
		o.authorize(w, r)
	case "/token":
		o.token(w, r)
	case "/revoke":
		o.revoke(w, r)
	default:
		http.NotFound(w, r)
	}
}
func validRedirect(s string) bool {
	u, e := url.Parse(s)
	if e != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http" && loopback(u.Hostname())
}
func (o *OAuth) register(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	if len(o.db.Clients) >= 128 {
		oauthError(w, 429, "registration_limit")
		return
	}
	var v struct {
		Redirects []string `json:"redirect_uris"`
		Name      string   `json:"client_name"`
		Method    string   `json:"token_endpoint_auth_method"`
		Grants    []string `json:"grant_types"`
		Responses []string `json:"response_types"`
	}
	if e := json.NewDecoder(r.Body).Decode(&v); e != nil || len(v.Redirects) == 0 || len(v.Redirects) > 10 || len(v.Name) > 128 {
		oauthError(w, 400, "invalid_client_metadata")
		return
	}
	if v.Method != "" && v.Method != "none" && v.Method != "client_secret_basic" {
		oauthError(w, 400, "invalid_client_metadata")
		return
	}
	for _, g := range v.Grants {
		if g != "authorization_code" && g != "refresh_token" {
			oauthError(w, 400, "invalid_client_metadata")
			return
		}
	}
	for _, s := range v.Responses {
		if s != "code" {
			oauthError(w, 400, "invalid_client_metadata")
			return
		}
	}
	for _, s := range v.Redirects {
		if len(s) > 2048 || !validRedirect(s) {
			oauthError(w, 400, "invalid_redirect_uri")
			return
		}
	}
	id := Random()
	method := v.Method
	if method == "" {
		method = "none"
	}
	secret := ""
	c := client{ID: id, Redirects: v.Redirects, Name: v.Name, Method: method}
	if method == "client_secret_basic" {
		secret = Random()
		c.SecretHash = Hash(secret)
	}
	o.db.Clients[id] = c
	if e := o.save(); e != nil {
		delete(o.db.Clients, id)
		oauthError(w, 500, "server_error")
		return
	}
	response := map[string]any{"client_id": c.ID, "redirect_uris": c.Redirects, "client_name": c.Name, "token_endpoint_auth_method": c.Method}
	if secret != "" {
		response["client_secret"] = secret
		response["client_secret_expires_at"] = 0
	}
	writeJSON(w, 201, response)
}

var consentTemplate = template.Must(template.New("consent").Parse(`<!doctype html><html><head><title>{{.Name}} consent</title></head><body><h1>Local authorization required</h1><p>Client: {{.Client}}</p><p>Redirect: {{.Redirect}}</p><p>Permission scope: {{.Scope}}</p><p>Read the matching authorization request in your local server terminal. Only enter its one-time consent code if you initiated this connection and approve this permission. The code expires in two minutes. Never send it to an AI agent.</p><form method="POST" action="/authorize"><input type="hidden" name="request_id" value="{{.ID}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><label>Local consent code <input type="password" name="consent_code" autocomplete="off" required></label><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></body></html>`))

func (o *OAuth) authorize(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" {
		o.consent(w, r)
		return
	}
	if r.Method != "GET" {
		w.WriteHeader(405)
		return
	}
	q := r.URL.Query()
	c, ok := o.db.Clients[q.Get("client_id")]
	redirect := q.Get("redirect_uri")
	challenge := q.Get("code_challenge")
	if !ok || !slices.Contains(c.Redirects, redirect) {
		oauthError(w, 400, "invalid_request")
		return
	}
	if q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || !validVerifier(challenge, 43, 43) || q.Get("state") == "" || len(q.Get("state")) > 1024 || q.Get("resource") != o.issuer+"/mcp" {
		oauthError(w, 400, "invalid_request")
		return
	}
	scope := q.Get("scope")
	if scope == "" {
		scope = o.scope
	}
	if scope != o.scope {
		oauthError(w, 400, "invalid_scope")
		return
	}
	o.prune()
	if len(o.db.Pending) >= 32 {
		oauthError(w, 429, "slow_down")
		return
	}
	id, consent, csrf, cookie := Random(), Random(), Random(), Random()
	p := pending{Client: c.ID, Redirect: redirect, State: q.Get("state"), Challenge: challenge, Resource: q.Get("resource"), Scope: scope, ConsentHash: Hash(consent), CSRFHash: Hash(csrf), CookieHash: Hash(cookie), Expires: o.now().Add(2 * time.Minute)}
	o.db.Pending[id] = p
	if e := o.save(); e != nil {
		delete(o.db.Pending, id)
		oauthError(w, 500, "server_error")
		return
	}
	// This is a local human consent code, never an access token or log record.
	fmt.Fprintf(o.notice, "OAuth consent request %s: client=%q redirect=%q scope=%q\nOne-time local consent code (2 minutes): %s\n", id, c.Name+" ["+c.ID+"]", redirect, scope, consent)
	http.SetCookie(w, &http.Cookie{Name: identity.Binary + "-consent-" + id, Value: cookie, Path: "/authorize", HttpOnly: true, Secure: strings.HasPrefix(o.issuer, "https:"), SameSite: http.SameSiteStrictMode, MaxAge: 120})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = consentTemplate.Execute(w, struct{ Name, Client, Redirect, Scope, ID, CSRF string }{identity.Name, c.Name, redirect, scope, id, csrf})
}
func (o *OAuth) consent(w http.ResponseWriter, r *http.Request) {
	if e := r.ParseForm(); e != nil {
		oauthError(w, 400, "invalid_request")
		return
	}
	id := r.PostForm.Get("request_id")
	p, ok := o.db.Pending[id]
	cookie, e := r.Cookie(identity.Binary + "-consent-" + id)
	if !ok || !o.now().Before(p.Expires) || e != nil || !Equal(Hash(cookie.Value), p.CookieHash) || !Equal(Hash(r.PostForm.Get("csrf")), p.CSRFHash) {
		oauthError(w, 400, "invalid_request")
		return
	}
	p.Attempts++
	if p.Attempts > 5 {
		delete(o.db.Pending, id)
		_ = o.save()
		oauthError(w, 400, "access_denied")
		return
	}
	if !Equal(Hash(r.PostForm.Get("consent_code")), p.ConsentHash) {
		o.db.Pending[id] = p
		_ = o.save()
		oauthError(w, 400, "access_denied")
		return
	}
	delete(o.db.Pending, id)
	u, _ := url.Parse(p.Redirect)
	q := u.Query()
	q.Set("state", p.State)
	q.Set("iss", o.issuer)
	if r.PostForm.Get("decision") != "approve" {
		q.Set("error", "access_denied")
	} else {
		code := Random()
		o.db.Codes[Hash(code)] = grant{p.Client, p.Redirect, p.Challenge, p.Resource, p.Scope, o.now().Add(time.Minute)}
		q.Set("code", code)
	}
	if e = o.save(); e != nil {
		oauthError(w, 500, "server_error")
		return
	}
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.String(), http.StatusSeeOther)
}
func validVerifier(s string, minLen, maxLen int) bool {
	if len(s) < minLen || len(s) > maxLen {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-._~", r)) {
			return false
		}
	}
	return true
}
func (o *OAuth) token(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	if e := r.ParseForm(); e != nil {
		oauthError(w, 400, "invalid_request")
		return
	}
	q := r.PostForm
	clientID, authenticated := o.authenticateClient(r)
	if !authenticated {
		oauthError(w, 401, "invalid_client")
		return
	}
	var cr credential
	switch q.Get("grant_type") {
	case "authorization_code":
		key := Hash(q.Get("code"))
		g, ok := o.db.Codes[key]
		if !ok || !o.now().Before(g.Expires) || g.Client != clientID || g.Redirect != q.Get("redirect_uri") || g.Resource != q.Get("resource") || !validVerifier(q.Get("code_verifier"), 43, 128) || !Equal(Hash(q.Get("code_verifier")), g.Challenge) {
			oauthError(w, 400, "invalid_grant")
			return
		}
		delete(o.db.Codes, key)
		cr = credential{Client: clientID, Resource: g.Resource, Scope: g.Scope, Family: Random()}
	case "refresh_token":
		key := Hash(q.Get("refresh_token"))
		g, ok := o.db.Refresh[key]
		if !ok || g.Client != clientID || g.Resource != q.Get("resource") || !o.now().Before(g.Expires) || o.db.Revoked[g.Family] {
			oauthError(w, 400, "invalid_grant")
			return
		}
		if g.Used {
			o.db.Revoked[g.Family] = true
			_ = o.save()
			oauthError(w, 400, "invalid_grant")
			return
		}
		if q.Get("scope") != "" && q.Get("scope") != g.Scope {
			oauthError(w, 400, "invalid_scope")
			return
		}
		g.Used = true
		o.db.Refresh[key] = g
		cr = g
		cr.Used = false
	default:
		oauthError(w, 400, "unsupported_grant_type")
		return
	}
	o.prune()
	if len(o.db.Access) >= 1024 || len(o.db.Refresh) >= 4096 {
		oauthError(w, 429, "slow_down")
		return
	}
	access, refresh := Random(), Random()
	cr.Expires = o.now().Add(accessLifetime)
	o.db.Access[Hash(access)] = cr
	cr.Expires = o.now().Add(refreshLifetime)
	o.db.Refresh[Hash(refresh)] = cr
	if e := o.save(); e != nil {
		delete(o.db.Access, Hash(access))
		delete(o.db.Refresh, Hash(refresh))
		oauthError(w, 500, "server_error")
		return
	}
	writeJSON(w, 200, map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": int(accessLifetime.Seconds()), "refresh_token": refresh, "scope": cr.Scope})
}
func (o *OAuth) Validate(token string) (string, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	g, ok := o.db.Access[Hash(token)]
	return g.Client, ok && !o.db.Revoked[g.Family] && o.now().Before(g.Expires) && g.Resource == o.issuer+"/mcp" && g.Scope == o.scope
}
func (o *OAuth) revoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	if e := r.ParseForm(); e != nil {
		oauthError(w, 400, "invalid_request")
		return
	}
	key := Hash(r.PostForm.Get("token"))
	id, ok := o.authenticateClient(r)
	if !ok {
		oauthError(w, 401, "invalid_client")
		return
	}
	for _, store := range []map[string]credential{o.db.Access, o.db.Refresh} {
		if g, ok := store[key]; ok && g.Client == id {
			o.db.Revoked[g.Family] = true
		}
	}
	if e := o.save(); e != nil {
		oauthError(w, 500, "server_error")
		return
	}
	w.WriteHeader(200)
}
func (o *OAuth) prune() {
	now := o.now()
	for k, v := range o.db.Pending {
		if !now.Before(v.Expires) {
			delete(o.db.Pending, k)
		}
	}
	for k, v := range o.db.Codes {
		if !now.Before(v.Expires) {
			delete(o.db.Codes, k)
		}
	}
	for k, v := range o.db.Access {
		if !now.Before(v.Expires) {
			delete(o.db.Access, k)
		}
	}
	for k, v := range o.db.Refresh {
		if !now.Before(v.Expires) {
			delete(o.db.Refresh, k)
		}
	}
	activeFamilies := map[string]bool{}
	for _, v := range o.db.Access {
		activeFamilies[v.Family] = true
	}
	for _, v := range o.db.Refresh {
		activeFamilies[v.Family] = true
	}
	for family := range o.db.Revoked {
		if !activeFamilies[family] {
			delete(o.db.Revoked, family)
		}
	}
}

func (o *OAuth) authenticateClient(r *http.Request) (string, bool) {
	id := r.PostForm.Get("client_id")
	basicID, secret, basic := r.BasicAuth()
	if basic {
		decodedID, e := url.QueryUnescape(basicID)
		if e != nil {
			return "", false
		}
		decodedSecret, e := url.QueryUnescape(secret)
		if e != nil {
			return "", false
		}
		if id != "" && id != decodedID {
			return "", false
		}
		c, ok := o.db.Clients[decodedID]
		return decodedID, ok && c.Method == "client_secret_basic" && Equal(Hash(decodedSecret), c.SecretHash)
	}
	c, ok := o.db.Clients[id]
	return id, ok && c.Method == "none" && r.PostForm.Get("client_secret") == "" && r.Header.Get("Authorization") == ""
}
