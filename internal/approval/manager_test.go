package approval

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/prompt"
)

type answers struct {
	values chan string
	calls  atomic.Int32
}

func (a *answers) Available() bool { return true }
func (a *answers) Ask(ctx context.Context, _ string) (string, error) {
	a.calls.Add(1)
	select {
	case v := <-a.values:
		return v, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
func (a *answers) Run(context.Context, []string) error { return nil }
func principal() auth.Principal {
	return auth.Principal{ID: "client", Session: "session", Scope: "mcp:user", Origin: "https://public.example", Authenticated: true}
}
func operation(key string) Operation {
	return Operation{Tool: "fs_write", Class: "write", Mode: "user", RequestKey: key, Digest: auth.Hash("exact arguments")}
}
func manager(t *testing.T, policy string, a *answers) *Manager {
	t.Helper()
	var p *prompt.Coordinator
	if a != nil {
		p = prompt.New(a)
	}
	m, e := New(context.Background(), t.TempDir(), policy, p, nil)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(m.Close)
	return m
}
func wait(t *testing.T, m *Manager, id string) Response {
	t.Helper()
	r, e := m.Status(context.Background(), principal(), id, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestApprovalPolicies(t *testing.T) {
	for _, answer := range []string{"y", "N", "a", "timeout", "headless"} {
		t.Run(answer, func(t *testing.T) {
			a := &answers{values: make(chan string, 2)}
			if answer != "timeout" {
				a.values <- answer
			}
			if answer == "headless" {
				a = nil
			}
			m := manager(t, "write", a)
			m.Timeout = 30 * time.Millisecond
			var calls atomic.Int32
			r, e := m.Submit(context.Background(), principal(), operation("one"), func() error { return nil }, func(context.Context) (any, error) { calls.Add(1); return "ok", nil }, 0)
			if e != nil {
				t.Fatal(e)
			}
			if r.Status != "pending" {
				t.Fatal(r)
			}
			r = wait(t, m, r.ID)
			if answer == "y" || answer == "a" {
				if r.Status != "completed" || calls.Load() != 1 {
					t.Fatal(r, calls.Load())
				}
			} else if r.Status != "denied" || calls.Load() != 0 {
				t.Fatal(r, calls.Load())
			}
			if answer == "a" {
				r, e = m.Submit(context.Background(), principal(), operation("two"), func() error { return nil }, func(context.Context) (any, error) { calls.Add(1); return nil, nil }, 0)
				if e != nil {
					t.Fatal(e)
				}
				r = wait(t, m, r.ID)
				if r.Status != "completed" || a.calls.Load() != 1 {
					t.Fatal(r)
				}
			}
		})
	}
}
func TestDeduplicationAndBindings(t *testing.T) {
	m := manager(t, "none", nil)
	var calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := m.Submit(context.Background(), principal(), operation("same"), func() error { return nil }, func(context.Context) (any, error) { calls.Add(1); return "result", nil }, -1)
			if e != nil || r.Status != "completed" {
				t.Error(r, e)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
	op := operation("same")
	op.Digest = "modified"
	if _, e := m.Submit(context.Background(), principal(), op, func() error { return nil }, nil, 0); e == nil {
		t.Fatal("modified operation accepted")
	}
	r, e := m.Submit(context.Background(), principal(), operation("same"), func() error { return nil }, nil, 0)
	if e != nil {
		t.Fatal(e)
	}
	p := principal()
	p.ID = "other"
	if _, e = m.Status(context.Background(), p, r.ID, 0); e == nil {
		t.Fatal("cross-client disclosure")
	}
	p = principal()
	p.Session = "other"
	if _, e = m.Status(context.Background(), p, r.ID, 0); e == nil {
		t.Fatal("cross-session disclosure")
	}
	if _, e = m.Status(context.Background(), principal(), r.ID, 26*time.Second); e == nil {
		t.Fatal("unbounded poll")
	}
}
func TestRevokeWhilePending(t *testing.T) {
	a := &answers{values: make(chan string, 1)}
	m := manager(t, "write", a)
	var revoked atomic.Bool
	p := principal()
	p.Check = func() error {
		if revoked.Load() {
			return auth.ErrUnauthorized
		}
		return nil
	}
	r, e := m.Submit(context.Background(), p, operation("revoke"), p.Check, func(context.Context) (any, error) { t.Error("executed revoked request"); return nil, nil }, 0)
	if e != nil {
		t.Fatal(e)
	}
	revoked.Store(true)
	a.values <- "y"
	r = wait(t, m, r.ID)
	if r.Status != "denied" {
		t.Fatal(r)
	}
}
func TestCrashDispatch(t *testing.T) {
	if dir := os.Getenv("BRIDGE_APPROVAL_CRASH_HELPER"); dir != "" {
		m, e := New(context.Background(), dir, "none", nil, nil)
		if e != nil {
			os.Exit(2)
		}
		_, _ = m.Submit(context.Background(), principal(), operation("crash"), func() error { return nil }, func(context.Context) (any, error) {
			_ = os.WriteFile(filepath.Join(dir, "effect"), []byte("once"), 0600)
			os.Exit(9)
			return nil, nil
		}, -1)
		os.Exit(3)
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashDispatch$")
	cmd.Env = append(os.Environ(), "BRIDGE_APPROVAL_CRASH_HELPER="+dir)
	if e := cmd.Run(); e == nil {
		t.Fatal("did not crash")
	}
	if _, e := os.Stat(filepath.Join(dir, "effect")); e != nil {
		t.Fatal(e)
	}
	m, e := New(context.Background(), dir, "none", nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	r, e := m.Submit(context.Background(), principal(), operation("crash"), func() error { return nil }, func(context.Context) (any, error) { t.Error("crash retried"); return nil, nil }, -1)
	if e != nil || r.Outcome != "unknown" {
		t.Fatal(r, e)
	}
	// A crash before dispatch cannot execute after recovery.
	entries, _ := filepath.Glob(filepath.Join(dir, "requests", "*.json"))
	for _, path := range entries {
		var rec record
		if platform.ReadJSON(path, &rec) == nil && rec.Response.ID != "" {
			rec.Response.Status = "approved"
			if e = platform.AtomicJSON(path, rec); e != nil {
				t.Fatal(e)
			}
			r, e = m.Status(context.Background(), principal(), rec.Response.ID, 0)
			if e != nil || r.Status != "denied" {
				t.Fatal(r, e)
			}
		}
	}
}
func TestAuditFailAndNoKey(t *testing.T) {
	m := manager(t, "none", nil)
	m.Audit = func(Operation, string, string, string) error { return errors.New("disk full") }
	if _, e := m.Submit(context.Background(), principal(), operation("audit"), func() error { return nil }, func(context.Context) (any, error) { t.Error("unaudited effect"); return nil, nil }, -1); e == nil {
		t.Fatal("audit ignored")
	}
	op := operation("")
	if _, e := m.Submit(context.Background(), principal(), op, func() error { return nil }, nil, 0); e == nil {
		t.Fatal("missing key accepted")
	}
}

func TestMissingResultPersistenceBecomesUnknown(t *testing.T) {
	m := manager(t, "none", nil)
	r, e := m.Submit(context.Background(), principal(), operation("missing-result"), func() error { return nil }, func(context.Context) (any, error) { return "done", nil }, -1)
	if e != nil {
		t.Fatal(e)
	}
	saved, e := m.load(r.ID)
	if e != nil {
		t.Fatal(e)
	}
	saved.Response.Status = "dispatched"
	saved.Response.Outcome = ""
	if e = m.save(saved); e != nil {
		t.Fatal(e)
	}
	r, e = m.Status(context.Background(), principal(), r.ID, 0)
	if e != nil || r.Outcome != "unknown" {
		t.Fatal(r, e)
	}
}
