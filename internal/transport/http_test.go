package transport

import (
	"context"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/mcpserver"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func handlerTest(t *testing.T) (*Handler, *httptest.Server) {
	t.Helper()
	c := config.Defaults()
	c.Roots = []string{t.TempDir()}
	c.StateDir = t.TempDir()
	os.Chmod(c.StateDir, 0700)
	a, e := mcpserver.New(c, true)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(a.Close)
	h := NewHandler(a, "secret", "127.0.0.1:1234", "", func() {})
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	return h, s
}
func TestHTTPValidation(t *testing.T) {
	h, s := handlerTest(t)
	for _, tc := range []struct {
		host, origin, token, path string
		status                    int
	}{{h.Host, "", "", "/mcp", 401}, {h.Host, "", "bad", "/mcp", 401}, {"evil.example", "", "secret", "/mcp", 403}, {h.Host, "https://evil.example", "secret", "/mcp", 403}, {h.Host, "", "", "/healthz", 200}, {h.Host, "", "secret", "/mcp?access_token=secret", 400}} {
		r, _ := http.NewRequest("GET", s.URL+tc.path, nil)
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		if tc.token != "" {
			r.Header.Set("Authorization", "Bearer "+tc.token)
		}
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.status {
			t.Fatal(tc, resp.StatusCode)
		}
	}
	body := strings.Repeat("x", (2<<20)+1)
	r, _ := http.NewRequest("POST", s.URL+"/mcp", strings.NewReader(body))
	r.Host = h.Host
	r.Header.Set("Authorization", "Bearer secret")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	resp, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 413 {
		t.Fatal(resp.StatusCode)
	}
}
func TestIdleDoesNotInterruptActive(t *testing.T) {
	h, _ := handlerTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopped := make(chan struct{})
	h.Stop = func() {
		select {
		case <-stopped:
		default:
			close(stopped)
		}
	}
	h.Active.Store(1)
	go h.Idle(ctx, 30*time.Millisecond)
	select {
	case <-stopped:
		t.Fatal("active request interrupted")
	case <-time.After(100 * time.Millisecond):
	}
	h.Last.Store(time.Now().UnixNano())
	h.Active.Store(0)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("idle not stopped")
	}
}
func TestConcurrentRequests(t *testing.T) {
	h, s := handlerTest(t)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/list"}`, i+1)
			r, _ := http.NewRequest("POST", s.URL+"/mcp", strings.NewReader(body))
			r.Host = h.Host
			r.Header.Set("Authorization", "Bearer secret")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Accept", "application/json, text/event-stream")
			r.Header.Set("MCP-Protocol-Version", "2025-11-25")
			resp, e := http.DefaultClient.Do(r)
			if e != nil {
				t.Error(e)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 && resp.StatusCode != 429 {
				t.Error(resp.StatusCode)
			}
		}(i)
	}
	wg.Wait()
}
func TestRemotePrivilegeDenied(t *testing.T) {
	for _, mode := range []string{"sudo", "dangerous"} {
		c := config.Defaults()
		c.Mode = policy.Mode(mode)
		c.AckDanger = true
		if _, e := mcpserver.New(c, true); e == nil {
			t.Fatal(mode)
		}
	}
}

func TestOlderProtocolRequests(t *testing.T) {
	h, s := handlerTest(t)
	for _, version := range []string{"2025-03-26", "2025-06-18", "2025-11-25"} {
		r, _ := http.NewRequest("POST", s.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		r.Host = h.Host
		r.Header.Set("Authorization", "Bearer secret")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "application/json, text/event-stream")
		r.Header.Set("MCP-Protocol-Version", version)
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
			t.Fatal(version, resp.StatusCode, resp.Header)
		}
	}
}

func TestAuthAndHostDenialAudit(t *testing.T) {
	h, s := handlerTest(t)
	for i := 0; i < 4; i++ {
		req, _ := http.NewRequest("GET", s.URL+"/mcp", nil)
		req.Host = "untrusted.example"
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
	}
	req, _ := http.NewRequest("POST", s.URL+"/mcp", strings.NewReader("{}"))
	req.Host = h.Host
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	b, e := os.ReadFile(filepath.Join(h.App.Config.StateDir, "audit", "audit.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	if strings.Count(string(b), `"operation":"http_host"`) != 1 || !strings.Contains(string(b), `"denial_reason":"auth"`) {
		t.Fatal(string(b))
	}
}
