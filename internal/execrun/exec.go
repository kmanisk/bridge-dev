package execrun

import (
	"bytes"
	"context"
	"errors"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const MaxOutput = 1 << 20
const MaxDuration = 10 * time.Minute

type Request struct {
	Argv           []string `json:"argv"`
	Cwd            string   `json:"cwd"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
}
type Result struct {
	Output    string `json:"output"`
	ExitCode  int    `json:"exit_code"`
	Signal    string `json:"signal,omitempty"`
	Truncated bool   `json:"truncated"`
	TimedOut  bool   `json:"timed_out"`
}
type Limited struct {
	Mu        sync.Mutex
	B         bytes.Buffer
	Limit     int
	Truncated bool
}

func (w *Limited) Write(b []byte) (int, error) {
	w.Mu.Lock()
	defer w.Mu.Unlock()
	n := len(b)
	left := w.Limit - w.B.Len()
	if left < len(b) {
		w.Truncated = true
		b = b[:max(0, left)]
	}
	_, _ = w.B.Write(b)
	return n, nil
}
func Environment(allow []string) []string {
	out := []string{"PATH=/usr/bin:/bin"}
	for _, k := range allow {
		if strings.ContainsAny(k, "=\x00") || k == "PATH" || strings.HasPrefix(k, "LD_") || strings.HasPrefix(k, "DYLD_") {
			continue
		}
		if v, ok := os.LookupEnv(k); ok {
			out = append(out, k+"="+v)
		}
	}
	return out
}
func SudoArgv(binary string, argv []string) []string {
	return append([]string{binary, "-n", "--"}, argv...)
}
func Prepare(j *fsjail.Jail, p policy.Commands, m policy.Mode, r Request, sudo bool) ([]string, *os.File, error) {
	if !m.Write() || sudo && !m.Privileged() {
		return nil, nil, errors.New("mode forbids execution")
	}
	if e := p.Check(r.Argv, sudo, m == policy.Dangerous); e != nil {
		return nil, nil, e
	}
	if !sudo && m != policy.Dangerous {
		switch filepath.Base(r.Argv[0]) {
		case "sudo", "doas", "pkexec":
			return nil, nil, errors.New("direct privilege brokers require explicit privileged execution")
		}
	}
	d, e := j.Directory(r.Cwd)
	if e != nil {
		return nil, nil, e
	}
	a := append([]string{}, r.Argv...)
	if sudo {
		a = SudoArgv("/usr/bin/sudo", a)
	}
	return a, d, nil
}
func Run(ctx context.Context, j *fsjail.Jail, p policy.Commands, m policy.Mode, r Request, sudo bool, env []string) (Result, error) {
	if r.TimeoutSeconds < 0 || r.TimeoutSeconds > 600 {
		return Result{}, errors.New("timeout must be between zero and 600 seconds")
	}
	a, d, e := Prepare(j, p, m, r, sudo)
	if e != nil {
		return Result{}, e
	}
	defer d.Close()
	duration := 30 * time.Second
	if r.TimeoutSeconds > 0 {
		duration = time.Duration(r.TimeoutSeconds) * time.Second
	}
	if duration > MaxDuration {
		return Result{}, errors.New("timeout exceeds 10 minutes")
	}
	ctx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	out := &Limited{Limit: MaxOutput}
	c := exec.Command(a[0], a[1:]...)
	c.Dir = DescriptorPath(d)
	c.Env = Environment(env)
	c.Stdout = out
	c.Stderr = out
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.WaitDelay = time.Second
	e = RunCommand(ctx, c)
	result := Result{Output: out.B.String(), Truncated: out.Truncated, TimedOut: errors.Is(ctx.Err(), context.DeadlineExceeded)}
	if c.ProcessState != nil {
		result.ExitCode = c.ProcessState.ExitCode()
		if s, ok := c.ProcessState.Sys().(syscall.WaitStatus); ok && s.Signaled() {
			result.Signal = s.Signal().String()
		}
	}
	if e != nil {
		var ex *exec.ExitError
		if !errors.As(e, &ex) && ctx.Err() == nil {
			return result, errors.New("command could not run")
		}
	}
	return result, nil
}

// RunCommand holds the group leader unreaped until every group signal has
// been sent. This prevents process-group IDs being recycled during cleanup.
func RunCommand(ctx context.Context, c *exec.Cmd) error {
	if e := c.Start(); e != nil {
		return e
	}
	exited := make(chan error, 1)
	go func() { exited <- waitUnreaped(c.Process.Pid) }()
	select {
	case <-exited:
		// A command may leave children holding output pipes. They belong to this
		// invocation and must not outlive a synchronous operation/task worker.
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	case <-ctx.Done():
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGTERM)
		timer := time.NewTimer(time.Second)
		select {
		case <-exited:
		case <-timer.C:
		}
		timer.Stop()
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	}
	return c.Wait()
}
