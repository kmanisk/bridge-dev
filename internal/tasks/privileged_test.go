package tasks

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/execrun"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPrivilegedSystemUnitAndColdContext(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "sudo-argv")
	os.WriteFile(filepath.Join(dir, "sudo"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > '"+log+"'\nexit 1\n"), 0700)
	os.WriteFile(filepath.Join(dir, "systemd-run"), []byte("#!/bin/sh\nexit 99\n"), 0700)
	t.Setenv("PATH", dir)
	c := config.Defaults()
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{dir}
	c.Mode = policy.Sudo
	m, e := New(c, "/fake/bridge-dev")
	if e != nil {
		t.Fatal(e)
	}
	j, e := fsjail.New(c.Roots)
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	task, e := m.Start(context.Background(), j, execrun.Request{Argv: []string{"/usr/bin/id"}, Cwd: dir}, true)
	if e == nil || task.Backend != "systemd-system" || task.State != "failed" {
		t.Fatal(task, e)
	}
	b, _ := os.ReadFile(log)
	for _, s := range []string{"-n\n--\n", "--system\n", "--property=User=", "--collect\n"} {
		if !strings.Contains(string(b), s) {
			t.Fatal(string(b))
		}
	}
	m.Config.GrantUntil = time.Now().Add(-time.Second)
	if _, e = m.Start(context.Background(), j, execrun.Request{Argv: []string{"/usr/bin/id"}, Cwd: dir}, true); e == nil {
		t.Fatal("expired dispatch")
	}
}

func TestWorkerOwnSudoContextFailsDurably(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "sudo"), []byte("#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n"), 0700)
	t.Setenv("PATH", dir)
	c := config.Defaults()
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{dir}
	c.Mode = policy.Sudo
	m, e := New(c, "/fake/bridge-dev")
	if e != nil {
		t.Fatal(e)
	}
	id := ID()
	taskDir, _ := m.path(id)
	os.Mkdir(taskDir, 0700)
	task := Task{ID: id, State: "starting", Backend: "systemd-system", Argv: []string{"/usr/bin/id"}, Cwd: dir, LogPath: filepath.Join(taskDir, "output.log"), Started: time.Now()}
	if e = platform.AtomicJSON(filepath.Join(taskDir, "spec.json"), spec{task, c, true}); e != nil {
		t.Fatal(e)
	}
	platform.AtomicJSON(filepath.Join(taskDir, "status.json"), task)
	if e = Worker(c.StateDir, id); e != nil {
		t.Fatal(e)
	}
	task, e = m.Status(id)
	if e != nil || task.ExitCode == nil || *task.ExitCode != 1 || task.State != "failed" {
		t.Fatal(task, e)
	}
	b, _ := os.ReadFile(task.LogPath)
	if !strings.Contains(string(b), "password is required") {
		t.Fatal(string(b))
	}
}
