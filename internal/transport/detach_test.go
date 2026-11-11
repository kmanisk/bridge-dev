package transport

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/config"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDetachedUnit(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "args")
	fake := filepath.Join(dir, "systemd-run")
	os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > '"+log+"'\n"), 0700)
	t.Setenv("PATH", dir)
	c := config.Defaults()
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{dir}
	unit, e := Detach(context.Background(), c)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(log)
	if !strings.Contains(string(b), "--collect\n") || !strings.Contains(string(b), "--headless\n") || strings.Contains(string(b), "enable") || unit == "" {
		t.Fatal(string(b))
	}
	c.OAuth = true
	c.Auth = "code"
	if _, e = Detach(context.Background(), c); e == nil {
		t.Fatal("code leaked to detached logs")
	}
}
