package integration

import (
	"context"
	"encoding/json"
	"github.com/kmanisk/bridge-dev/internal/tasks"
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

func TestTaskSurvivesServerCrash(t *testing.T) {
	root, state := t.TempDir(), privateTemp(t)
	cmd := exec.Command(binary, "stdio", "--roots", root, "--state-dir", state, "--mode", "user", "--task-backend", "detached", "--allow-commands", "/bin/sh")
	cmd.Env = isolatedEnv(t)
	cmd.Stderr = os.Stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "crash-test", Version: "1"}, nil)
	s, e := client.Connect(context.Background(), &mcp.CommandTransport{Command: cmd}, nil)
	if e != nil {
		t.Fatal(e)
	}
	out := call(t, s, "task_start", map[string]any{"argv": []string{"/bin/sh", "-c", "sleep 2; printf survived; exit 3"}, "cwd": root})
	var task tasks.Task
	if e = json.Unmarshal(out["data"], &task); e != nil {
		t.Fatal(e)
	}
	if e = cmd.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	_ = s.Close()
	s = stdio(t, root, state, "user", "detached")
	defer s.Close()
	out = call(t, s, "task_wait", map[string]any{"id": task.ID, "timeout_seconds": 10})
	json.Unmarshal(out["data"], &task)
	if task.ExitCode == nil || *task.ExitCode != 3 {
		t.Fatal(task)
	}
	out = call(t, s, "task_logs", map[string]any{"id": task.ID})
	var logs tasks.Logs
	json.Unmarshal(out["data"], &logs)
	if logs.Text != "survived" {
		t.Fatal(logs)
	}
}
func TestHTTPIdleKeepsActualRequestAlive(t *testing.T) {
	state, root := privateTemp(t), t.TempDir()
	cmd := exec.Command(binary, "up", "--state-dir", state, "--roots", root, "--port", "0", "--mode", "user", "--allow-commands", "/bin/sleep", "--idle-timeout", "500ms")
	cmd.Env = isolatedEnv(t)
	cmd.Stderr = os.Stderr
	if e := cmd.Start(); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Signal(os.Interrupt) })
	var rt transport.Runtime
	deadline := time.Now().Add(3 * time.Second)
	for {
		b, e := os.ReadFile(filepath.Join(state, "http.json"))
		if e == nil && json.Unmarshal(b, &rt) == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("startup")
		}
		time.Sleep(10 * time.Millisecond)
	}
	token, e := os.ReadFile(filepath.Join(state, "token"))
	if e != nil {
		t.Fatal(e)
	}
	c := mcp.NewClient(&mcp.Implementation{Name: "active-idle-test", Version: "1"}, nil)
	s, e := c.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: rt.URL + "/mcp", HTTPClient: &http.Client{Transport: bearerTransport{strings.TrimSpace(string(token))}}, DisableStandaloneSSE: true}, nil)
	if e != nil {
		t.Fatal(e)
	}
	call(t, s, "exec", map[string]any{"argv": []string{"/bin/sleep", "2"}, "cwd": root})
	select {
	case <-done:
		t.Fatal("active request lost to idle shutdown")
	default:
	}
	_ = s.Close()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not idle exit")
	}
}

func TestAuditFailureRefusesSideEffect(t *testing.T) {
	root, state := t.TempDir(), privateTemp(t)
	s := stdio(t, root, state, "user", "detached")
	defer s.Close()
	lock := filepath.Join(state, "audit", "audit.lock")
	if e := os.Mkdir(lock, 0700); e != nil {
		t.Fatal(e)
	}
	r, e := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "fs_write", Arguments: map[string]any{"path": "must-not-exist", "content": "denied"}})
	if e == nil && (r == nil || !r.IsError) {
		t.Fatal("audit failure allowed write")
	}
	if _, e = os.Stat(filepath.Join(root, "must-not-exist")); !os.IsNotExist(e) {
		t.Fatal("side effect despite failed audit", e)
	}
}
