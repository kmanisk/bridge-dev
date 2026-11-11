// Package tasks runs durable workers independent of MCP transport lifetimes.
package tasks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/execrun"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

const MaxLog = 16 << 20

type Task struct {
	MemoryBytes     int64         `json:"memory_bytes,omitempty"`
	ID              string        `json:"id"`
	Argv            []string      `json:"argv"`
	Cwd             string        `json:"cwd"`
	Started         time.Time     `json:"started"`
	Completed       *time.Time    `json:"completed,omitempty"`
	State           string        `json:"state"`
	ExitCode        *int          `json:"exit_code,omitempty"`
	Signal          string        `json:"signal,omitempty"`
	PID             int           `json:"pid"`
	ProcessIdentity string        `json:"process_identity"`
	Unit            string        `json:"unit,omitempty"`
	Backend         string        `json:"backend"`
	LogPath         string        `json:"log_path"`
	Truncated       bool          `json:"truncated"`
	CPUSeconds      float64       `json:"cpu_seconds,omitempty"`
	PeakMemoryBytes int64         `json:"peak_memory_bytes,omitempty"`
	Config          config.Config `json:"-"`
}
type spec struct {
	Task   Task          `json:"task"`
	Config config.Config `json:"config"`
	Sudo   bool          `json:"sudo"`
}
type Manager struct {
	Dir    string
	Config config.Config
	Binary string
}

func New(c config.Config, binary string) (*Manager, error) {
	dir := filepath.Join(c.StateDir, "tasks")
	if e := platform.PrivateDir(dir); e != nil {
		return nil, e
	}
	return &Manager{dir, c, binary}, nil
}
func ID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func (m *Manager) path(id string) (string, error) {
	if len(id) != 32 {
		return "", errors.New("invalid task ID")
	}
	if _, e := hex.DecodeString(id); e != nil {
		return "", errors.New("invalid task ID")
	}
	return filepath.Join(m.Dir, id), nil
}
func (m *Manager) Start(ctx context.Context, j *fsjail.Jail, r execrun.Request, sudo bool) (Task, error) {
	a, d, e := execrun.Prepare(j, policy.Commands{Allow: m.Config.Allow, Deny: m.Config.Deny, SudoAllow: m.Config.SudoAllow}, m.Config.Mode, r, sudo)
	if e != nil {
		return Task{}, e
	}
	_ = a
	d.Close()
	id := ID()
	dir, _ := m.path(id)
	t := Task{ID: id, Argv: append([]string{}, r.Argv...), Cwd: r.Cwd, Started: time.Now().UTC(), State: "starting", LogPath: filepath.Join(dir, "output.log"), Backend: "detached"}
	backend := m.Config.Backend
	if sudo {
		if runtime.GOOS != "linux" {
			return Task{}, errors.New("privileged background tasks require Linux systemd system units")
		}
		if !m.Config.GrantUntil.IsZero() && !time.Now().Before(m.Config.GrantUntil) {
			return Task{}, errors.New("privileged grant expired")
		}
		t.Backend = "systemd-system"
		t.Unit = identity.Binary + "-task-" + id + ".service"
	}
	if !sudo && runtime.GOOS == "linux" && backend != "detached" {
		checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		e = exec.CommandContext(checkCtx, "systemctl", "--user", "show-environment").Run()
		cancel()
		if e == nil {
			t.Backend = "systemd"
			t.Unit = identity.Binary + "-task-" + id + ".service"
		} else if backend == "systemd" {
			return Task{}, errors.New("systemd user manager unavailable")
		}
	}
	if runtime.GOOS != "linux" && backend == "systemd" {
		return Task{}, errors.New("systemd backend unavailable")
	}
	if e = os.Mkdir(dir, 0700); e != nil {
		return Task{}, e
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(dir)
		}
	}()
	log, e := os.OpenFile(t.LogPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return Task{}, e
	}
	if e = log.Close(); e != nil {
		return Task{}, e
	}
	if e = platform.AtomicJSON(filepath.Join(dir, "spec.json"), spec{t, m.Config, sudo}); e != nil {
		return Task{}, e
	}
	if e = platform.AtomicJSON(filepath.Join(dir, "status.json"), t); e != nil {
		return Task{}, e
	}
	args := []string{"_task-worker", m.Config.StateDir, id}
	c := exec.Command(m.Binary, args...)
	if t.Backend == "systemd" {
		args = append([]string{"--user", "--quiet", "--collect", "--service-type=exec", "--unit=" + t.Unit, "--property=Restart=no", "--property=TimeoutStopSec=5s", "--", m.Binary}, args...)
		c = exec.CommandContext(ctx, "systemd-run", args...)
	} else if t.Backend == "systemd-system" {
		sudoPath, se := exec.LookPath("sudo")
		if se != nil {
			return Task{}, se
		}
		systemd, se := exec.LookPath("systemd-run")
		if se != nil {
			return Task{}, se
		}
		args = append([]string{systemd, "--system", "--quiet", "--collect", "--service-type=exec", "--unit=" + t.Unit, "--property=Restart=no", "--property=TimeoutStopSec=5s", fmt.Sprintf("--property=User=%d", os.Getuid()), fmt.Sprintf("--property=Group=%d", os.Getgid()), "--", m.Binary}, args...)
		c = exec.CommandContext(ctx, sudoPath, append([]string{"-n", "--"}, args...)...)
	} else {
		c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	}
	f, e := os.OpenFile(filepath.Join(dir, "worker.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return Task{}, e
	}
	defer f.Close()
	c.Stdout = f
	c.Stderr = f
	c.Stdin = nil
	if t.Backend == "systemd" || t.Backend == "systemd-system" {
		e = c.Run()
	} else {
		e = c.Start()
		if e == nil {
			go func() { _ = c.Wait() }()
		}
	}
	cleanup = false
	if e != nil {
		now := time.Now().UTC()
		code := -1
		t.Completed = &now
		t.ExitCode = &code
		t.State = "failed"
		_ = m.recordCompletion(&t)
		_ = platform.AtomicJSON(filepath.Join(dir, "status.json"), t)
		return t, errors.New("task worker launch failed; inspect worker.log")
	}
	// The worker owns durable state from this point. MCP cancellation cannot kill it.
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		t, e = m.Status(id)
		if e != nil || t.State != "starting" {
			return t, e
		}
		select {
		case <-deadline.C:
			return t, nil
		case <-tick.C:
		}
	}
}
func (m *Manager) Status(id string) (Task, error) { return m.status(id, true) }
func (m *Manager) status(id string, metrics bool) (Task, error) {
	dir, e := m.path(id)
	if e != nil {
		return Task{}, e
	}
	var t Task
	if e = platform.ReadJSON(filepath.Join(dir, "status.json"), &t); e != nil {
		return t, e
	}
	if t.ID != id {
		return Task{}, errors.New("task metadata identity mismatch")
	}
	if t.State == "starting" && time.Since(t.Started) > 10*time.Second {
		t.State = "lost"
	}
	if t.State == "running" {
		identity, e := platform.ProcessIdentity(t.PID)
		if e != nil || identity != t.ProcessIdentity {
			t.State = "lost"
		} else if metrics {
			liveMetrics(&t)
		}
	}
	if t.Completed == nil {
		_ = m.recoverCompletion(&t)
	}
	return t, nil
}
func (m *Manager) List() ([]Task, error) {
	es, e := os.ReadDir(m.Dir)
	if e != nil {
		return nil, e
	}
	out := []Task{}
	for _, d := range es {
		if !d.IsDir() {
			continue
		}
		if _, e := m.path(d.Name()); e != nil {
			continue
		}
		t, e := m.Status(d.Name())
		if e != nil {
			return nil, e
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Started.Before(out[j].Started) })
	return out, nil
}
func (m *Manager) Wait(ctx context.Context, id string, timeout time.Duration) (Task, error) {
	if timeout <= 0 {
		timeout = 25 * time.Second
	}
	if timeout > 25*time.Second {
		return Task{}, errors.New("task_wait maximum is 25 seconds")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		t, e := m.status(id, false)
		if e != nil || t.State != "running" && t.State != "starting" {
			return t, e
		}
		select {
		case <-ctx.Done():
			return t, nil
		case <-tick.C:
		}
	}
}
func (m *Manager) Stop(ctx context.Context, id string) (Task, error) {
	t, e := m.Status(id)
	if e != nil {
		return t, e
	}
	if t.State != "running" && t.State != "starting" {
		return t, errors.New("task is not running; refusing to signal an unverified process")
	}
	dir, _ := m.path(id)
	if e = platform.Atomic(filepath.Join(dir, "stop"), []byte("stop\n")); e != nil {
		return t, e
	}
	return m.Wait(ctx, id, 5*time.Second)
}
func (m *Manager) Restart(ctx context.Context, j *fsjail.Jail, id string) (Task, error) {
	t, e := m.Status(id)
	if e != nil {
		return t, e
	}
	if t.State == "running" || t.State == "starting" {
		return t, errors.New("stop task before restart")
	}
	dir, _ := m.path(id)
	var s spec
	if e = platform.ReadJSON(filepath.Join(dir, "spec.json"), &s); e != nil {
		return t, e
	}
	return m.Start(ctx, j, execrun.Request{Argv: t.Argv, Cwd: t.Cwd}, s.Sudo)
}
func (m *Manager) Forget(id string) error {
	t, e := m.Status(id)
	if e != nil {
		return e
	}
	if t.State == "running" || t.State == "starting" || t.State == "lost" {
		return errors.New("only completed tasks can be forgotten")
	}
	dir, _ := m.path(id)
	return os.RemoveAll(dir)
}

type Logs struct {
	Text string `json:"text"`
	Next int64  `json:"next_offset"`
	EOF  bool   `json:"eof"`
}

func (m *Manager) Logs(id string, offset int64) (Logs, error) {
	if offset < 0 {
		return Logs{}, errors.New("negative offset")
	}
	if _, e := m.Status(id); e != nil {
		return Logs{}, e
	}
	dir, _ := m.path(id)
	f, e := os.Open(filepath.Join(dir, "output.log"))
	if e != nil {
		return Logs{}, e
	}
	defer f.Close()
	if _, e = f.Seek(offset, io.SeekStart); e != nil {
		return Logs{}, e
	}
	limit := m.Config.ReadBytes
	if limit == 0 && m.Config.Mode != policy.Dangerous {
		limit = 64 << 10
	}
	var reader io.Reader = f
	if limit > 0 {
		reader = io.LimitReader(f, limit)
	}
	b, e := io.ReadAll(reader)
	if e != nil {
		return Logs{}, e
	}
	s, e := f.Stat()
	if e != nil {
		return Logs{}, e
	}
	next := offset + int64(len(b))
	return Logs{string(b), next, next >= s.Size()}, nil
}

func (m *Manager) Cursor(client string, ack string) (string, error) {
	if client == "" || len(client) > 128 || strings.ContainsAny(client, "/\\\x00") {
		return "", errors.New("invalid client cursor identity")
	}
	dir := filepath.Join(m.Dir, "cursors")
	if e := platform.PrivateDir(dir); e != nil {
		return "", e
	}
	unlock, e := platform.Lock(filepath.Join(dir, client+".lock"))
	if e != nil {
		return "", e
	}
	defer unlock()
	p := filepath.Join(dir, client+".json")
	var old string
	e = platform.ReadJSON(p, &old)
	if e != nil && !os.IsNotExist(e) {
		return "", e
	}
	if ack > old {
		events, e := m.Events(old)
		if e != nil {
			return "", e
		}
		found := false
		for _, v := range events {
			if v.Cursor == ack {
				found = true
			}
		}
		if !found {
			return "", errors.New("acknowledgment is not a pending event cursor")
		}
		if e = platform.AtomicJSON(p, ack); e != nil {
			return "", e
		}
		old = ack
	}
	return old, nil
}

func (m *Manager) Execution(id string) (execrun.Request, bool, error) {
	dir, e := m.path(id)
	if e != nil {
		return execrun.Request{}, false, e
	}
	var s spec
	e = platform.ReadJSON(filepath.Join(dir, "spec.json"), &s)
	return execrun.Request{Argv: s.Task.Argv, Cwd: s.Task.Cwd}, s.Sudo, e
}
