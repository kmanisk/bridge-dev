package integration

import (
	"context"
	"encoding/json"
	"github.com/kmanisk/bridge-dev/internal/transport"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBuiltHTTPPendingCeilingAndRetry(t *testing.T) {
	root, state := t.TempDir(), privateTemp(t)
	cmd := exec.Command(binary, "up", "--headless", "--roots", root, "--state-dir", state, "--port", "0", "--mode", "user", "--allow-commands", "/bin/sh", "--idle-timeout", "1m")
	cmd.Env = isolatedEnv(t)
	if e := cmd.Start(); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		cmd.Process.Signal(os.Interrupt)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("server did not exit")
		}
	})
	var rt transport.Runtime
	until := time.Now().Add(5 * time.Second)
	for {
		b, e := os.ReadFile(filepath.Join(state, "http.json"))
		if e == nil && json.Unmarshal(b, &rt) == nil {
			break
		}
		if time.Now().After(until) {
			t.Fatal("startup")
		}
		time.Sleep(10 * time.Millisecond)
	}
	token, e := os.ReadFile(filepath.Join(state, "token"))
	if e != nil {
		t.Fatal(e)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "pending integration", Version: "1"}, nil)
	s, e := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: rt.URL + "/mcp", HTTPClient: &http.Client{Transport: bearerTransport{strings.TrimSpace(string(token))}}, DisableStandaloneSSE: true}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	args := map[string]any{"argv": []string{"/bin/sh", "-c", "printf x >> dispatch-count; sleep 27; exit 3"}, "cwd": root, "request_key": "long-logical-call"}
	start := time.Now()
	out := call(t, s, "exec", args)
	elapsed := time.Since(start)
	var pending struct {
		ID     string `json:"pending_id"`
		Status string `json:"status"`
	}
	if e = json.Unmarshal(out["data"], &pending); e != nil || pending.ID == "" || pending.Status != "dispatched" || elapsed >= 25*time.Second {
		t.Fatal(pending, elapsed, e)
	}
	out = call(t, s, "approval_status", map[string]any{"id": pending.ID, "timeout_seconds": 10})
	var complete struct {
		Status string `json:"status"`
	}
	json.Unmarshal(out["data"], &complete)
	if complete.Status != "completed" {
		t.Fatal(complete)
	}
	out = call(t, s, "exec", args)
	var result struct {
		ExitCode int `json:"exit_code"`
	}
	json.Unmarshal(out["data"], &result)
	if result.ExitCode != 3 {
		t.Fatal(result)
	}
	b, _ := os.ReadFile(filepath.Join(root, "dispatch-count"))
	if string(b) != "x" {
		t.Fatal("duplicate execution", string(b))
	}
}
