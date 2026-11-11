package transport

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"io"
	"os"
	"path/filepath"
	"testing"
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
