package integration

import (
	"context"
	"encoding/json"
	"fmt"
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

var binary string
var subprocessCoverage string

func TestMain(m *testing.M) {
	dir, e := os.MkdirTemp("", "bridge-dev-integration-")
	if e != nil {
		panic(e)
	}
	binary = filepath.Join(dir, "bridge-dev")
	subprocessCoverage = filepath.Join(dir, "coverage")
	if e = os.Mkdir(subprocessCoverage, 0700); e != nil {
		panic(e)
	}
	buildArgs := []string{"build", "-cover", "-coverpkg=github.com/kmanisk/bridge-dev/internal/...,github.com/kmanisk/bridge-dev/cmd/...", "-o", binary}
	cgo := "0"
	if integrationRace {
		buildArgs = append(buildArgs, "-race")
		cgo = "1"
	}
	buildArgs = append(buildArgs, "../cmd/bridge-dev")
	c := exec.Command("go", buildArgs...)
	c.Env = append(os.Environ(), "CGO_ENABLED="+cgo)
	if b, e := c.CombinedOutput(); e != nil {
		fmt.Fprintln(os.Stderr, string(b), e)
		os.RemoveAll(dir)
		os.Exit(1)
	}
	code := m.Run()
	if out := os.Getenv("BRIDGE_DEV_COVERAGE_OUT"); out != "" {
		if e = os.MkdirAll(out, 0700); e != nil {
			fmt.Fprintln(os.Stderr, e)
			code = 1
		} else {
			report := exec.Command("go", "tool", "covdata", "textfmt", "-i="+subprocessCoverage, "-o="+filepath.Join(out, "subprocess.out"))
			if b, e := report.CombinedOutput(); e != nil {
				fmt.Fprintln(os.Stderr, string(b), e)
				code = 1
			}
			percent := exec.Command("go", "tool", "covdata", "percent", "-i="+subprocessCoverage)
			if b, e := percent.CombinedOutput(); e == nil {
				_ = os.WriteFile(filepath.Join(out, "subprocess-percent.txt"), b, 0600)
			} else {
				fmt.Fprintln(os.Stderr, e)
				code = 1
			}
		}
	}
	os.RemoveAll(dir)
	os.Exit(code)
}
func stdio(t *testing.T, root, state, mode, backend string) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "integration", Version: "1"}, nil)
	cmd := exec.Command(binary, "stdio", "--headless", "--roots", root, "--state-dir", state, "--mode", mode, "--task-backend", backend, "--allow-commands", "/bin/echo,/bin/sh,/bin/sleep")
	if mode == "sudo" || mode == "dangerous" {
		cfg := filepath.Join(privateTemp(t), "privileged.toml")
		os.WriteFile(cfg, []byte("ack_privileged = true\n"), 0600)
		cmd.Args = append(cmd.Args, "--config", cfg)
	}
	cmd.Stderr = os.Stderr
	cmd.Env = isolatedEnv(t)
	s, e := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func call(t *testing.T, s *mcp.ClientSession, name string, args map[string]any) map[string]json.RawMessage {
	t.Helper()
	switch name {
	case "probe_write", "fs_write", "fs_edit", "exec", "sudo_exec", "task_start", "task_stop", "task_restart", "task_forget":
		if args == nil {
			args = map[string]any{}
		}
		if _, ok := args["request_key"]; !ok {
			args["request_key"] = fmt.Sprintf("%d", time.Now().UnixNano())
		}
	}
	r, e := s.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if e != nil || r.IsError {
		t.Fatalf("%s: %v %+v", name, e, r)
	}
	var out map[string]json.RawMessage
	b, e := json.Marshal(r.StructuredContent)
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(b, &out); e != nil {
		t.Fatal(e, string(b))
	}
	return out
}
func TestBuiltStdioModes(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "hello"), []byte("hello"), 0600)
	for _, mode := range []string{"readonly", "user", "sudo"} {
		t.Run(mode, func(t *testing.T) {
			s := stdio(t, root, privateTemp(t), mode, "detached")
			defer s.Close()
			list, e := s.ListTools(context.Background(), nil)
			if e != nil {
				t.Fatal(e)
			}
			found := map[string]bool{}
			for _, tool := range list.Tools {
				found[tool.Name] = true
			}
			for _, name := range []string{"fs_read", "fs_list", "fs_search", "search", "fetch", "proc_list", "task_list", "task_status", "task_logs", "task_wait"} {
				if !found[name] {
					t.Fatal("missing readonly tool", name)
				}
			}
			for _, name := range []string{"fs_write", "fs_edit", "exec", "task_start", "task_stop", "task_restart", "task_forget"} {
				if found[name] != (mode != "readonly") {
					t.Fatal("mode registry mismatch", name, mode)
				}
			}
			if !found["fs_read"] || found["exec"] != (mode != "readonly") || found["sudo_exec"] != (mode == "sudo") {
				t.Fatal(found)
			}
			out := call(t, s, "fs_read", map[string]any{"path": "hello"})
			if string(out["data"]) != "\"hello\"" {
				t.Fatal(out)
			}
			if mode == "readonly" {
				r, e := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "exec", Arguments: map[string]any{"argv": []string{"/bin/echo", "denied"}, "cwd": root}})
				if e == nil && (r == nil || !r.IsError) {
					t.Fatal("unavailable tool was callable")
				}
			}
			if mode != "readonly" {
				call(t, s, "fs_write", map[string]any{"path": "written", "content": "ok"})
				call(t, s, "fs_write", map[string]any{"path": "binary", "content": "AP/+", "encoding": "base64"})
				br := call(t, s, "fs_read", map[string]any{"path": "binary"})
				var encoded map[string]string
				json.Unmarshal(br["data"], &encoded)
				if encoded["encoding"] != "base64" || encoded["content"] != "AP/+" {
					t.Fatal(encoded)
				}
				call(t, s, "exec", map[string]any{"argv": []string{"/bin/echo", "literal"}, "cwd": root})
			}
		})
	}
}
func TestDurableTasks(t *testing.T) {
	for _, backend := range []string{"detached", "systemd"} {
		t.Run(backend, func(t *testing.T) {
			if backend == "systemd" {
				if e := exec.Command("systemctl", "--user", "show-environment").Run(); e != nil {
					t.Skip("no user manager")
				}
			}
			root, state := t.TempDir(), privateTemp(t)
			s := stdio(t, root, state, "user", backend)
			out := call(t, s, "task_start", map[string]any{"argv": []string{"/bin/sh", "-c", "printf first; sleep 2; printf second; exit 7"}, "cwd": root})
			var task tasks.Task
			if e := json.Unmarshal(out["data"], &task); e != nil {
				t.Fatal(e)
			}
			if backend == "systemd" && task.State == "running" && task.MemoryBytes <= 0 {
				t.Fatal("missing live cgroup memory metric", task)
			}
			s.Close()
			s = stdio(t, root, state, "user", backend)
			defer func() { s.Close() }()
			out = call(t, s, "task_wait", map[string]any{"id": task.ID, "timeout_seconds": 10, "client_id": "test"})
			json.Unmarshal(out["data"], &task)
			if task.ExitCode == nil || *task.ExitCode != 7 || task.State != "failed" {
				t.Fatal(task)
			}
			if backend == "systemd" {
				deadline := time.Now().Add(5 * time.Second)
				for {
					b, _ := exec.Command("systemctl", "--user", "show", task.Unit, "-p", "LoadState", "--value").Output()
					if strings.TrimSpace(string(b)) == "not-found" {
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("unit not collected: %s", b)
					}
					time.Sleep(50 * time.Millisecond)
				}
				s.Close()
				s = stdio(t, root, state, "user", backend)
				after := call(t, s, "task_status", map[string]any{"id": task.ID})
				var saved tasks.Task
				json.Unmarshal(after["data"], &saved)
				if saved.ExitCode == nil || *saved.ExitCode != 7 {
					t.Fatal("exit status lost after collection/restart", saved)
				}
			}
			logs := call(t, s, "task_logs", map[string]any{"id": task.ID})
			var l tasks.Logs
			json.Unmarshal(logs["data"], &l)
			if l.Text != "firstsecond" {
				t.Fatal(l)
			}
			out = call(t, s, "task_logs", map[string]any{"id": task.ID, "offset": l.Next})
			json.Unmarshal(out["data"], &l)
			if l.Text != "" {
				t.Fatal(l)
			}
			events := call(t, s, "task_list", map[string]any{"client_id": "test"})
			var cursor string
			json.Unmarshal(events["completion_cursor"], &cursor)
			if cursor == "" {
				t.Fatal("missing completion")
			}
			events = call(t, s, "task_list", map[string]any{"client_id": "test", "ack": cursor})
			if string(events["completions"]) != "[]" {
				t.Fatal(events)
			}
			restarted := call(t, s, "task_restart", map[string]any{"id": task.ID})
			var next tasks.Task
			json.Unmarshal(restarted["data"], &next)
			if next.ID == task.ID {
				t.Fatal("restart reused ID")
			}
			call(t, s, "task_wait", map[string]any{"id": next.ID, "timeout_seconds": 10})
			call(t, s, "task_forget", map[string]any{"id": next.ID})
			if r, e := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "task_status", Arguments: map[string]any{"id": next.ID}}); e == nil && !r.IsError {
				t.Fatal("forgotten task remained visible")
			}
			out = call(t, s, "task_start", map[string]any{"argv": []string{"/bin/sleep", "30"}, "cwd": root})
			json.Unmarshal(out["data"], &task)
			out = call(t, s, "task_stop", map[string]any{"id": task.ID})
			json.Unmarshal(out["data"], &task)
			if task.State != "stopped" {
				t.Fatal(task)
			}
		})
	}
}

type bearerTransport struct{ token string }

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}
func TestHTTPProbeBinary(t *testing.T) {
	state, root := privateTemp(t), t.TempDir()
	cmd := exec.Command(binary, "up", "--state-dir", state, "--roots", root, "--port", "0", "--probe", "--idle-timeout", "2s")
	cmd.Env = isolatedEnv(t)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if e := cmd.Start(); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Signal(os.Interrupt) })
	var rt transport.Runtime
	deadline := time.Now().Add(5 * time.Second)
	for {
		b, e := os.ReadFile(filepath.Join(state, "http.json"))
		if e == nil && json.Unmarshal(b, &rt) == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("startup timeout", stderr.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	resp, e := http.Get(rt.URL + "/mcp")
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal(resp.StatusCode)
	}
	b, e := os.ReadFile(filepath.Join(state, "token"))
	if e != nil {
		t.Fatal(e)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "http-probe", Version: "1"}, nil)
	s, e := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: rt.URL + "/mcp", HTTPClient: &http.Client{Transport: bearerTransport{strings.TrimSpace(string(b))}}, DisableStandaloneSSE: true}, nil)
	if e != nil {
		t.Fatal(e)
	}
	list, e := s.ListTools(context.Background(), nil)
	if e != nil || len(list.Tools) != 4 {
		t.Fatal(list, e)
	}
	for _, tool := range list.Tools {
		if tool.Annotations == nil || tool.Annotations.ReadOnlyHint != (tool.Name != "probe_write") {
			t.Fatal("probe annotations", tool.Name)
		}
	}
	for _, name := range []string{"probe_read", "probe_write", "search"} {
		call(t, s, name, map[string]any{})
	}
	s.Close()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("idle exit failed")
	}
}

func privateTemp(t *testing.T) string {
	t.Helper()
	p := t.TempDir()
	if e := os.Chmod(p, 0700); e != nil {
		t.Fatal(e)
	}
	return p
}

func isolatedEnv(t *testing.T) []string {
	fakeDir := t.TempDir()
	if e := os.WriteFile(filepath.Join(fakeDir, "sudo"), []byte("#!/bin/sh\necho 'fake sudo: interactive authentication disabled in tests' >&2\nexit 1\n"), 0700); e != nil {
		t.Fatal(e)
	}

	t.Helper()
	out := []string{}
	for _, v := range os.Environ() {
		if strings.HasPrefix(v, "BRIDGE_DEV_") || strings.HasPrefix(v, "XDG_CONFIG_HOME=") || strings.HasPrefix(v, "PATH=") || strings.HasPrefix(v, "GOCOVERDIR=") || strings.HasPrefix(v, "HOME=") || strings.HasPrefix(v, "XDG_STATE_HOME=") || strings.HasPrefix(v, "XDG_CACHE_HOME=") || strings.HasPrefix(v, "XDG_DATA_HOME=") {
			continue
		}
		out = append(out, v)
	}
	return append(out, "PATH="+fakeDir+":"+os.Getenv("PATH"), "XDG_CONFIG_HOME="+t.TempDir(), "XDG_STATE_HOME="+t.TempDir(), "XDG_CACHE_HOME="+t.TempDir(), "XDG_DATA_HOME="+t.TempDir(), "HOME="+t.TempDir(), "GOCOVERDIR="+subprocessCoverage)
}
