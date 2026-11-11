package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

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
