package mcpserver

import (
	"context"
	"encoding/json"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/tasks"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type scriptedPrompt struct{ answers chan string }

func (p *scriptedPrompt) Available() bool { return true }
func (p *scriptedPrompt) Ask(ctx context.Context, _ string) (string, error) {
	select {
	case a := <-p.answers:
		return a, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
func (p *scriptedPrompt) Run(context.Context, []string) error { return nil }
func appTest(t *testing.T, mode policy.Mode) *App {
	t.Helper()
	c := config.Defaults()
	c.Roots = []string{t.TempDir()}
	c.StateDir = t.TempDir()
	os.Chmod(c.StateDir, 0700)
	root := c.Roots[0]
	c.Mode = mode
	c.AckDanger = true
	c.PrivilegedAuthorized = true
	a, e := New(c, false)
	if e != nil {
		t.Fatal(e)
	}
	a.Config.Roots = []string{root}
	t.Cleanup(a.Close)
	return a
}
func clientTest(t *testing.T, a *App) *mcp.ClientSession {
	t.Helper()
	ct, st := mcp.NewInMemoryTransports()
	ss, e := a.Server.Connect(context.Background(), st, nil)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { ss.Close() })
	cs, e := mcp.NewClient(&mcp.Implementation{Name: "unverified client", Version: "test"}, nil).Connect(context.Background(), ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}
func TestRegistryAndFilesystem(t *testing.T) {
	for _, mode := range []policy.Mode{policy.Readonly, policy.User, policy.Sudo, policy.Dangerous} {
		t.Run(string(mode), func(t *testing.T) {
			a := appTest(t, mode)
			cs := clientTest(t, a)
			clients := a.Events.Clients()
			if len(clients) != 1 || clients[0].Name != "unverified client" {
				t.Fatal("initialize name missing", clients)
			}
			list, e := cs.ListTools(context.Background(), nil)
			if e != nil {
				t.Fatal(e)
			}
			found := map[string]bool{}
			for _, tool := range list.Tools {
				found[tool.Name] = true
			}
			if found["fs_write"] != mode.Write() || found["sudo_exec"] != mode.Privileged() || !found["approval_status"] {
				t.Fatal(found)
			}
			os.WriteFile(filepath.Join(a.Config.Roots[0], "read"), []byte("value"), 0600)
			r, e := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "fs_read", Arguments: map[string]any{"path": filepath.Join(a.Config.Roots[0], "read")}})
			if e != nil || r.IsError {
				t.Fatal(r, e)
			}
		})
	}
}
func TestPendingApprovalAndRetry(t *testing.T) {
	a := appTest(t, policy.User)
	a.Config.Approve = "write"
	p := &scriptedPrompt{answers: make(chan string, 1)}
	if e := a.ConfigurePrompts(context.Background(), prompt.New(p)); e != nil {
		t.Fatal(e)
	}
	cs := clientTest(t, a)
	args := map[string]any{"path": "write", "content": "approved", "request_key": "logical-one"}
	start := time.Now()
	r, e := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "fs_write", Arguments: args})
	if e != nil || r.IsError || time.Since(start) > time.Second {
		t.Fatal(r, e)
	}
	var out struct {
		Data struct {
			ID     string `json:"pending_id"`
			Status string `json:"status"`
		} `json:"data"`
	}
	b, _ := json.Marshal(r.StructuredContent)
	json.Unmarshal(b, &out)
	if out.Data.Status != "pending" {
		t.Fatal(string(b))
	}
	if _, e = os.Stat(filepath.Join(a.Config.Roots[0], "write")); !os.IsNotExist(e) {
		t.Fatal("early effect")
	}
	p.answers <- "y"
	r, e = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "approval_status", Arguments: map[string]any{"id": out.Data.ID, "timeout_seconds": 1}})
	if e != nil || r.IsError {
		t.Fatal(r, e)
	}
	b, e = os.ReadFile(filepath.Join(a.Config.Roots[0], "write"))
	if e != nil || string(b) != "approved" {
		t.Fatal(string(b), e)
	}
	// Retry does not overwrite an independently changed file.
	os.WriteFile(filepath.Join(a.Config.Roots[0], "write"), []byte("later"), 0600)
	r, e = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "fs_write", Arguments: args})
	if e != nil || r.IsError {
		t.Fatal(r, e)
	}
	b, _ = os.ReadFile(filepath.Join(a.Config.Roots[0], "write"))
	if string(b) != "later" {
		t.Fatal("duplicate effect")
	}
}

func TestGrantExpiryRegistryAndQueue(t *testing.T) {
	a := appTest(t, policy.Sudo)
	cs := clientTest(t, a)
	a.Grant.Revoke()
	list, e := cs.ListTools(context.Background(), nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, tool := range list.Tools {
		if tool.Name == "sudo_exec" || tool.Name == "exec" || tool.Name == "fs_write" {
			t.Fatal("expired capability listed", tool.Name)
		}
	}
	if e = a.Authorize("sudo_exec", Input{}, "sudo"); e == nil {
		t.Fatal("expired invocation authorized")
	}
}
func TestRemotePrivilegeRequiresAuthorization(t *testing.T) {
	c := config.Defaults()
	c.StateDir = t.TempDir()
	os.Chmod(c.StateDir, 0700)
	c.Roots = []string{t.TempDir()}
	c.Mode = policy.Sudo
	if _, e := New(c, true); e == nil {
		t.Fatal("bearer privilege")
	}
	c.OAuth = true
	if _, e := New(c, true); e == nil {
		t.Fatal("missing current acknowledgment")
	}
}

func TestQueuedPrivilegeExpires(t *testing.T) {
	fake := t.TempDir()
	os.WriteFile(filepath.Join(fake, "sudo"), []byte("#!/bin/sh\nexit 98\n"), 0700)
	t.Setenv("PATH", fake)
	a := appTest(t, policy.Sudo)
	a.Config.Approve = "sudo"
	p := &scriptedPrompt{answers: make(chan string, 1)}
	if e := a.ConfigurePrompts(context.Background(), prompt.New(p)); e != nil {
		t.Fatal(e)
	}
	cs := clientTest(t, a)
	r, e := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "sudo_exec", Arguments: map[string]any{"argv": []string{"/usr/bin/id"}, "cwd": a.Config.Roots[0], "request_key": "expires"}})
	if e != nil || r.IsError {
		t.Fatal(r, e)
	}
	var result struct {
		Data struct {
			ID string `json:"pending_id"`
		} `json:"data"`
	}
	b, _ := json.Marshal(r.StructuredContent)
	json.Unmarshal(b, &result)
	a.Grant.Revoke()
	p.answers <- "y"
	response, e := a.Approvals.Status(context.Background(), auth.Identity(context.Background()), result.Data.ID, time.Second)
	if e != nil || response.Status != "denied" || response.Reason != "expired" {
		t.Fatal(response, e)
	}
}

func TestTaskResourceAndApprovalBoundary(t *testing.T) {
	a := appTest(t, policy.Readonly)
	cs := clientTest(t, a)
	templates, e := cs.ListResourceTemplates(context.Background(), nil)
	if e != nil || len(templates.ResourceTemplates) != 2 {
		t.Fatal(templates, e)
	}
	id := tasks.ID()
	dir := filepath.Join(a.Config.StateDir, "tasks", id)
	os.Mkdir(dir, 0700)
	code := 0
	now := time.Now()
	task := tasks.Task{ID: id, State: "completed", Completed: &now, ExitCode: &code, LogPath: filepath.Join(dir, "output.log")}
	platform.AtomicJSON(filepath.Join(dir, "status.json"), task)
	os.WriteFile(task.LogPath, []byte("resource-log"), 0600)
	r, e := cs.ReadResource(context.Background(), &mcp.ReadResourceParams{URI: identity.Name + "-task:///" + id + "/logs?offset=4"})
	if e != nil || len(r.Contents) != 1 || !strings.Contains(r.Contents[0].Text, "urce-log") {
		t.Fatal(r, e)
	}
	a2 := appTest(t, policy.Readonly)
	a2.Config.Approve = "all" // Registration is fixed at construction, checked with a fresh application below.
	c := a2.Config
	c.StateDir = t.TempDir()
	os.Chmod(c.StateDir, 0700)
	a3, e := New(c, false)
	if e != nil {
		t.Fatal(e)
	}
	defer a3.Close()
	templates, e = clientTest(t, a3).ListResourceTemplates(context.Background(), nil)
	if e != nil || len(templates.ResourceTemplates) != 0 {
		t.Fatal("resource approval bypass", templates, e)
	}
}

func TestInvocationScopeAndAuditContent(t *testing.T) {
	a := appTest(t, policy.User)
	a.Remote = true
	cs := clientTest(t, a) // A bare in-memory remote client has no authenticated principal.
	r, e := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "fs_write", Arguments: map[string]any{"path": "no-write", "content": "SECRET_CONTENT", "request_key": "no-auth"}})
	if e == nil && !r.IsError {
		t.Fatal("unauthenticated remote write")
	}
	if _, e = os.Stat(filepath.Join(a.Config.Roots[0], "no-write")); !os.IsNotExist(e) {
		t.Fatal("unauthenticated side effect")
	}
	b, e := os.ReadFile(filepath.Join(a.Config.StateDir, "audit", "audit.jsonl"))
	if e != nil || strings.Contains(string(b), "SECRET_CONTENT") {
		t.Fatal("audit content leak", e)
	}
}

func TestDangerousCloseReleasesSafeRoots(t *testing.T) {
	a := appTest(t, policy.Dangerous)
	a.Close()
	f, e := a.SafeJail.Directory(".")
	if f != nil {
		f.Close()
	}
	if e == nil {
		t.Fatal("safe root descriptor leaked")
	}
}
