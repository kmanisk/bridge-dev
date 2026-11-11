package transport

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPartialAndMissingState(t *testing.T) {
	c := config.Defaults()
	c.StateDir = filepath.Join(t.TempDir(), "state")
	c.Roots = []string{t.TempDir()}
	c.Port = 0
	rt, e := Status(c)
	if e != nil || rt.State != "stopped" {
		t.Fatal(rt, e)
	}
	if e = Down(context.Background(), c); e != nil {
		t.Fatal(e)
	}
	platform.PrivateDir(c.StateDir)
	unlock, e := platform.Lock(filepath.Join(c.StateDir, "http.lock"))
	if e != nil {
		t.Fatal(e)
	}
	rt, e = Status(c)
	if e != nil || rt.State != "partial" {
		t.Fatal(rt, e)
	}
	if Down(context.Background(), c) == nil {
		t.Fatal("unverified owner stopped")
	}
	unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e = RunWithOptions(ctx, c, Options{Out: io.Discard, Ready: func(rt Runtime) {
		os.Remove(filepath.Join(c.StateDir, "http.json"))
		live, e := Status(c)
		if e != nil || live.State != "running" || live.PID != os.Getpid() {
			t.Error(live, e)
		}
		if e = Down(context.Background(), c); e != nil {
			t.Error(e)
		}
	}})
	if e != nil {
		t.Fatal(e)
	}
	rt, e = Status(c)
	if e != nil || rt.State != "stopped" {
		t.Fatal(rt, e)
	}
}

type watchWriter struct{ lines chan string }

func (w watchWriter) Write(p []byte) (int, error) { w.lines <- string(p); return len(p), nil }
func TestWatchRotatesAndStops(t *testing.T) {
	c := config.Defaults()
	c.StateDir = t.TempDir()
	dir := filepath.Join(c.StateDir, "audit")
	os.Mkdir(dir, 0700)
	path := filepath.Join(dir, "audit.jsonl")
	os.WriteFile(path, []byte("{\"event\":\"first\"}\n"), 0600)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lines := make(chan string, 4)
	done := make(chan error, 1)
	go func() { done <- Watch(ctx, c, watchWriter{lines}) }()
	receive := func(want string) {
		t.Helper()
		select {
		case line := <-lines:
			if !strings.Contains(line, want) {
				t.Fatal(line)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("watch did not emit", want)
		}
	}
	receive("first")
	os.Rename(path, path+".1")
	os.WriteFile(path, []byte("{\"event\":\"second\"}\n"), 0600)
	receive("second")
	cancel()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("watch did not stop")
	}
}
