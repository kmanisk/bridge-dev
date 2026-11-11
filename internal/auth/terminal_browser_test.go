package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kmanisk/bridge-dev/internal/prompt"
)

type browserResponseCode struct {
	http.ResponseWriter
	code int
}

func (w *browserResponseCode) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

// TestTerminalRealBrowserRedirect exercises a real browser navigation from an
// initiating origin through the scripted consent page to an OAuth callback.
// It skips when no installed headless Chromium/Chrome is available.
func TestTerminalRealBrowserRedirect(t *testing.T) {
	var browser string
	for _, name := range []string{"google-chrome", "chromium", "chromium-browser"} {
		if path, err := exec.LookPath(name); err == nil {
			browser = path
			break
		}
	}
	if browser == "" {
		t.Skip("Chromium/Chrome not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	o, err := NewOAuth(t.TempDir(), "http://127.0.0.1:1234", "readonly", io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	o.ConfigureTerminal(ctx, prompt.New(&terminalAnswers{answer: "y"}), []string{"127.0.0.1"})
	approved := make(chan struct{})
	o.OnConsent = func(_ string, status string) error {
		if status == "approved" {
			close(approved)
		}
		return nil
	}
	defer o.Close()
	var gets, posts, postBad atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Chrome's virtual-time budget can dispatch the first POST before the
		// local asynchronous prompt worker runs. Wait only in this test fixture,
		// so the browser checks the approved redirect rather than timer pacing.
		if r.URL.Path == "/authorize" && r.Method == http.MethodPost {
			select {
			case <-approved:
			case <-time.After(3 * time.Second):
			}
		}
		recorder := &browserResponseCode{ResponseWriter: w}
		o.ServeHTTP(recorder, r)
		if r.URL.Path == "/authorize" {
			if r.Method == http.MethodGet {
				gets.Add(1)
			} else if r.Method == http.MethodPost {
				posts.Add(1)
				if recorder.code == http.StatusBadRequest {
					postBad.Add(1)
				}
			}
		}
	}))
	defer srv.Close()
	received := make(chan url.Values, 1)
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case received <- r.URL.Query():
		default:
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, "<!doctype html><title>OAuth callback complete</title><p>bridge-browser-callback-ok</p>")
	}))
	defer callback.Close()

	redirect := callback.URL + "/callback"
	request, err := json.Marshal(map[string]any{
		"redirect_uris":              []string{redirect},
		"client_name":                "local browser regression",
		"token_endpoint_auth_method": "none",
	})
	if err != nil {
		t.Fatal(err)
	}
	r, err := http.Post(srv.URL+"/register", "application/json", bytes.NewReader(request))
	if err != nil {
		t.Fatal(err)
	}
	var registration struct {
		ClientID string `json:"client_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&registration); err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusCreated || registration.ClientID == "" {
		t.Fatalf("OAuth registration status %d", r.StatusCode)
	}
	verifier := Random()
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {registration.ClientID},
		"redirect_uri":          {redirect},
		"state":                 {"browser-test-state"},
		"code_challenge":        {Hash(verifier)},
		"code_challenge_method": {"S256"},
		"resource":              {o.issuer + "/mcp"},
		"scope":                 {"mcp:readonly"},
	}
	target := srv.URL + "/authorize?" + q.Encode()
	start := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target, http.StatusFound)
	}))
	defer start.Close()
	// localhost -> 127.0.0.1 is a cross-site top-level OAuth navigation.
	startURL := strings.Replace(start.URL, "127.0.0.1", "localhost", 1) + "/start"
	command := exec.CommandContext(ctx, browser,
		"--headless", "--no-sandbox", "--disable-gpu",
		"--disable-dev-shm-usage", "--no-first-run",
		"--disable-background-networking", "--virtual-time-budget=8000",
		"--user-data-dir="+t.TempDir(), "--dump-dom", startURL)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("headless browser did not finish OAuth navigation: %v", err)
	}
	if !bytes.Contains(output, []byte("bridge-browser-callback-ok")) {
		reason := "unexpected_page"
		switch {
		case bytes.Contains(output, []byte("invalid_request")):
			reason = "oauth_invalid_request"
		case bytes.Contains(output, []byte("invalid origin")):
			reason = "origin_rejected"
		case bytes.Contains(output, []byte("Confirm in the local Bridge terminal")):
			reason = "consent_page_still_waiting"
		case bytes.Contains(output, []byte("ERR_CONNECTION")):
			reason = "browser_connection_error"
		case bytes.Contains(output, []byte("chrome-error")):
			reason = "browser_error_page"
		}
		t.Fatalf("headless browser callback missing category=%s authorize_get=%d authorize_post=%d rejected_post=%d", reason, gets.Load(), posts.Load(), postBad.Load())
	}
	var callbackQuery url.Values
	select {
	case callbackQuery = <-received:
	default:
		t.Fatal("callback server did not receive authorization code")
	}
	if callbackQuery.Get("state") != "browser-test-state" || callbackQuery.Get("iss") != o.issuer || callbackQuery.Get("code") == "" {
		t.Fatal("browser callback lacks expected OAuth state/issuer/code")
	}
	code := callbackQuery.Get("code")
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {registration.ClientID},
		"redirect_uri":  {redirect},
		"resource":      {o.issuer + "/mcp"},
		"code":          {code},
		"code_verifier": {verifier},
	}
	tokens, err := http.PostForm(srv.URL+"/token", form)
	if err != nil {
		t.Fatal(err)
	}
	tokens.Body.Close()
	if tokens.StatusCode != http.StatusOK {
		t.Fatalf("PKCE token exchange status %d", tokens.StatusCode)
	}
	replay, err := http.PostForm(srv.URL+"/token", form)
	if err != nil {
		t.Fatal(err)
	}
	replay.Body.Close()
	if replay.StatusCode != http.StatusBadRequest {
		t.Fatalf("PKCE code replay status %d", replay.StatusCode)
	}
}
