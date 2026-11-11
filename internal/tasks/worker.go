package tasks

import (
	"context"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/audit"
	"github.com/kmanisk/bridge-dev/internal/execrun"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type logWriter struct {
	mu        sync.Mutex
	file      *os.File
	size      int
	truncated bool
}

func (w *logWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	remaining := MaxLog - w.size
	if len(p) > remaining {
		p = p[:max(0, remaining)]
		w.truncated = true
	}
	written, e := w.file.Write(p)
	w.size += written
	return n, e
}
func Worker(state, id string) error {
	m := &Manager{Dir: filepath.Join(state, "tasks")}
	dir, e := m.path(id)
	if e != nil {
		return e
	}
	unlock, e := platform.TryLock(filepath.Join(dir, "worker.lock"))
	if e != nil {
		return e
	}
	defer unlock()
	var s spec
	if e = platform.ReadJSON(filepath.Join(dir, "spec.json"), &s); e != nil {
		return e
	}
	t := s.Task
	if t.ID != id || t.Completed != nil {
		return errors.New("invalid worker metadata")
	}
	var previous Task
	if e = platform.ReadJSON(filepath.Join(dir, "status.json"), &previous); e != nil || previous.State != "starting" {
		return errors.New("worker already ran")
	}
	t.PID = os.Getpid()
	t.ProcessIdentity, e = platform.ProcessIdentity(t.PID)
	if e != nil {
		return e
	}
	t.State = "running"
	finish := func(code int, sig string) {
		now := time.Now().UTC()
		t.Completed = &now
		t.ExitCode = &code
		t.Signal = sig
		t.State = "completed"
		if code != 0 {
			t.State = "failed"
		}
		if _, e := os.Stat(filepath.Join(dir, "stop")); e == nil {
			t.State = "stopped"
		}
		// Retry storage failures without dropping a known final result. This is
		// an active task finalizer, not a resident service. The user can inspect
		// worker.log and restore storage; forced kill still reports lost.
		for {
			if e = m.recordCompletion(&t); e == nil {
				e = platform.AtomicJSON(filepath.Join(dir, "status.json"), t)
			}
			if e == nil {
				break
			}
			fmt.Fprintln(os.Stderr, "task completion persistence failed; retrying")
			time.Sleep(time.Second)
		}
	}
	if e = platform.AtomicJSON(filepath.Join(dir, "status.json"), t); e != nil {
		return e
	}
	roots := s.Config.Roots
	if s.Config.Mode == policy.Dangerous {
		roots = []string{"/"}
	}
	j, e := fsjail.New(roots)
	if e != nil {
		finish(-1, "")
		return e
	}
	defer j.Close()
	if s.Config.Mode == policy.Dangerous {
		j.Unrestricted()
	}
	if s.Sudo {
		if !s.Config.GrantUntil.IsZero() && !time.Now().Before(s.Config.GrantUntil) {
			finish(-1, "")
			return errors.New("privileged grant expired before worker dispatch")
		}
	}

	a, d, e := execrun.Prepare(j, policy.Commands{Allow: s.Config.Allow, Deny: s.Config.Deny, SudoAllow: s.Config.SudoAllow}, s.Config.Mode, execrun.Request{Argv: t.Argv, Cwd: t.Cwd}, s.Sudo)
	if e != nil {
		finish(-1, "")
		return e
	}
	defer d.Close()
	log, e := os.OpenFile(t.LogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		finish(-1, "")
		return e
	}
	defer log.Close()
	w := &logWriter{file: log}
	c := exec.Command(a[0], a[1:]...)
	c.Dir = execrun.DescriptorPath(d)
	c.Env = execrun.Environment(s.Config.Env)
	c.Stdout = w
	c.Stderr = w
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.WaitDelay = 2 * time.Second
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-tick.C:
				if _, e := os.Stat(filepath.Join(dir, "stop")); e == nil {
					cancel()
					return
				}
			}
		}
	}()
	e = execrun.RunCommand(ctx, c)
	if s.Sudo && e != nil {
		fmt.Fprintln(os.Stderr, "sudo -n command failed in worker context; terminal cache may be unavailable. Inspect task output; use explicitly configured scoped NOPASSWD rules if appropriate. Never send a password through MCP.")
	}
	code := -1
	sig := ""
	if c.ProcessState != nil {
		code = c.ProcessState.ExitCode()
		t.CPUSeconds = c.ProcessState.UserTime().Seconds() + c.ProcessState.SystemTime().Seconds()
		t.PeakMemoryBytes = peakMemory(c.ProcessState)
		if st, ok := c.ProcessState.Sys().(syscall.WaitStatus); ok && st.Signaled() {
			sig = st.Signal().String()
		}
	}
	t.Truncated = w.truncated
	_ = log.Sync()
	finish(code, sig)
	for {
		al, ae := audit.New(filepath.Join(state, "audit"))
		if ae == nil {
			ae = al.Write(audit.Record{Client: "task-worker", Operation: "task_complete", Mode: string(s.Config.Mode), Allowed: true, Phase: "result", TaskID: id, ExitCode: &code, Sudo: s.Sudo, DurationMS: time.Since(t.Started).Milliseconds()})
		}
		if ae == nil {
			break
		}
		fmt.Fprintln(os.Stderr, "task completion audit failed; retrying")
		time.Sleep(time.Second)
	}
	return nil
}
