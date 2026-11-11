package tasks

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/execrun"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMonotonicCompletionAndForget(t *testing.T) {
	c := config.Defaults()
	c.StateDir = t.TempDir()
	os.Chmod(c.StateDir, 0700)
	m, e := New(c, "")
	if e != nil {
		t.Fatal(e)
	}
	code := 0
	now := time.Now()
	one := Task{ID: ID(), State: "completed", Completed: &now, ExitCode: &code}
	if e = m.recordCompletion(&one); e != nil {
		t.Fatal(e)
	}
	earlier := now.Add(-time.Hour)
	two := Task{ID: ID(), State: "completed", Completed: &earlier, ExitCode: &code}
	if e = m.recordCompletion(&two); e != nil {
		t.Fatal(e)
	}
	events, e := m.Events("")
	if e != nil || len(events) != 2 || events[0].ID != one.ID || events[1].ID != two.ID {
		t.Fatal(events, e)
	}
	p, _ := m.path(one.ID)
	os.Mkdir(p, 0700)
	platform.AtomicJSON(filepath.Join(p, "status.json"), one)
	if e = m.Forget(one.ID); e != nil {
		t.Fatal(e)
	}
	events, e = m.Events("")
	if e != nil || len(events) != 2 {
		t.Fatal("forget lost completion", events, e)
	}
	cursor, e := m.Cursor("client", events[0].Cursor)
	if e != nil {
		t.Fatal(e)
	}
	events, e = m.Events(cursor)
	if e != nil || len(events) != 1 || events[0].ID != two.ID {
		t.Fatal(events, e)
	}
}
func TestRecoveryFromIndependentCompletion(t *testing.T) {
	c := config.Defaults()
	c.StateDir = t.TempDir()
	os.Chmod(c.StateDir, 0700)
	m, _ := New(c, "")
	now := time.Now()
	code := 9
	final := Task{ID: ID(), State: "failed", Completed: &now, ExitCode: &code}
	if e := m.recordCompletion(&final); e != nil {
		t.Fatal(e)
	}
	p, _ := m.path(final.ID)
	os.Mkdir(p, 0700)
	platform.AtomicJSON(filepath.Join(p, "status.json"), Task{ID: final.ID, State: "running", PID: 99999999})
	got, e := m.Status(final.ID)
	if e != nil || got.State != "failed" || got.ExitCode == nil || *got.ExitCode != 9 {
		t.Fatal(got, e)
	}
}

func TestStartFailureDoesNotPoisonListing(t *testing.T) {
	c := config.Defaults()
	c.StateDir = t.TempDir()
	os.Chmod(c.StateDir, 0700)
	c.Roots = []string{t.TempDir()}
	c.Mode = "user"
	c.Allow = []string{"/bin/echo"}
	c.Backend = "systemd"
	m, e := New(c, "/missing/bridge-dev")
	if e != nil {
		t.Fatal(e)
	}
	j, e := fsjail.New(c.Roots)
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	t.Setenv("PATH", t.TempDir())
	if _, e = m.Start(context.Background(), j, execrun.Request{Argv: []string{"/bin/echo", "test"}, Cwd: c.Roots[0]}, false); e == nil {
		t.Fatal("unavailable backend accepted")
	}
	list, e := m.List()
	if e != nil || len(list) != 0 {
		t.Fatal("failed admission left invalid task", list, e)
	}
	m.Config.Backend = "detached"
	task, e := m.Start(context.Background(), j, execrun.Request{Argv: []string{"/bin/echo", "test"}, Cwd: c.Roots[0]}, false)
	if e == nil || task.State != "failed" {
		t.Fatal(task, e)
	}
	list, e = m.List()
	if e != nil || len(list) != 1 {
		t.Fatal(list, e)
	}
	if _, e = m.Logs(task.ID, 0); e != nil {
		t.Fatal("missing startup log", e)
	}
}
func TestStalePIDIsNeverSignaled(t *testing.T) {
	c := config.Defaults()
	c.StateDir = t.TempDir()
	os.Chmod(c.StateDir, 0700)
	m, e := New(c, "")
	if e != nil {
		t.Fatal(e)
	}
	id := ID()
	dir, _ := m.path(id)
	os.Mkdir(dir, 0700)
	platform.AtomicJSON(filepath.Join(dir, "status.json"), Task{ID: id, State: "running", PID: os.Getpid(), ProcessIdentity: "stale-identity"})
	task, e := m.Stop(context.Background(), id)
	if e == nil || task.State != "lost" {
		t.Fatal(task, e)
	}
	if _, e = os.Stat(filepath.Join(dir, "stop")); !os.IsNotExist(e) {
		t.Fatal("unverified process received stop request")
	}
}
