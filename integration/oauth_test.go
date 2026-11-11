package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/transport"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestBuiltOAuthHTTP(t *testing.T) {
	root, state := t.TempDir(), privateTemp(t)
	notice, e := os.CreateTemp(t.TempDir(), "notice-")
	if e != nil {
		t.Fatal(e)
	}
	defer notice.Close()
	cmd := exec.Command(binary, "up", "--state-dir", state, "--roots", root, "--port", "0", "--oauth", "--auth", "code", "--redirect-hosts", "127.0.0.1", "--mode", "user", "--allow-commands", "/bin/echo", "--idle-timeout", "1m")
	cmd.Stderr = notice
	cmd.Env = isolatedEnv(t)
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("server did not stop")
		}
	})
	var rt transport.Runtime
	deadline := time.Now().Add(5 * time.Second)
	for {
		b, e := os.ReadFile(filepath.Join(state, "http.json"))
		if e == nil && json.Unmarshal(b, &rt) == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("startup")
		}
		time.Sleep(20 * time.Millisecond)
	}
	jar, _ := cookiejar.New(nil)
	hc := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	post, e := hc.Post(rt.URL+"/register", "application/json", strings.NewReader(`{"redirect_uris":["http://127.0.0.1:9999/callback"],"client_name":"built-client","token_endpoint_auth_method":"none"}`))
	if e != nil {
		t.Fatal(e)
	}
	var reg map[string]any
	json.NewDecoder(post.Body).Decode(&reg)
	post.Body.Close()
	if post.StatusCode != 201 {
		t.Fatal(reg)
	}
	id := reg["client_id"].(string)
	verifier := auth.Random()
	q := url.Values{"response_type": {"code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "state": {"safe-client-state"}, "code_challenge": {auth.Hash(verifier)}, "code_challenge_method": {"S256"}, "resource": {rt.URL + "/mcp"}, "scope": {"mcp:user"}}
	r, e := hc.Get(rt.URL + "/authorize?" + q.Encode())
	if e != nil {
		t.Fatal(e)
	}
	html, _ := io.ReadAll(r.Body)
	r.Body.Close()
	hidden := func(name string) string {
		v := regexp.MustCompile(`name="` + name + `" value="([^"]+)"`).FindSubmatch(html)
		if len(v) != 2 {
			t.Fatal(string(html))
		}
		return string(v[1])
	}
	b, e := os.ReadFile(notice.Name())
	if e != nil {
		t.Fatal(e)
	}
	consent := regexp.MustCompile(`code \(2 minutes\): ([A-Za-z0-9_-]+)`).FindSubmatch(b)
	if len(consent) != 2 {
		t.Fatal("consent not emitted")
	}
	r, e = hc.PostForm(rt.URL+"/authorize", url.Values{"request_id": {hidden("request_id")}, "csrf": {hidden("csrf")}, "consent_code": {string(consent[1])}, "decision": {"approve"}})
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 303 {
		t.Fatal(r.StatusCode)
	}
	u, _ := url.Parse(r.Header.Get("Location"))
	r, e = hc.PostForm(rt.URL+"/token", url.Values{"grant_type": {"authorization_code"}, "client_id": {id}, "redirect_uri": {"http://127.0.0.1:9999/callback"}, "code": {u.Query().Get("code")}, "code_verifier": {verifier}, "resource": {rt.URL + "/mcp"}})
	if e != nil {
		t.Fatal(e)
	}
	var token map[string]any
	json.NewDecoder(r.Body).Decode(&token)
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatal(token)
	}
	access := token["access_token"].(string)
	client := mcp.NewClient(&mcp.Implementation{Name: "oauth-integration", Version: "1"}, nil)
	session, e := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: rt.URL + "/mcp", HTTPClient: &http.Client{Transport: bearerTransport{access}}, DisableStandaloneSSE: true}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	call(t, session, "exec", map[string]any{"argv": []string{"/bin/echo", "safe"}, "cwd": root})
	list, e := session.ListTools(context.Background(), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, tool := range list.Tools {
		if tool.Name == "sudo_exec" {
			t.Fatal("remote sudo")
		}
	}
	audit, e := os.ReadFile(filepath.Join(state, "audit", "audit.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(audit, []byte(access)) {
		t.Fatal("token audit leak")
	}
	if !bytes.Contains(audit, []byte(id)) {
		t.Fatal("authenticated identity not propagated", string(audit))
	}
	r, e = hc.PostForm(rt.URL+"/revoke", url.Values{"client_id": {id}, "token": {access}})
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	req, _ := http.NewRequest("POST", rt.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json")
	r, e = hc.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 401 {
		t.Fatal(fmt.Sprint(r.StatusCode))
	}
}
