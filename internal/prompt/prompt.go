// Package prompt serializes all human interaction on the controlling terminal.
package prompt

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/sys/unix"
)

var ErrUnavailable = errors.New("interactive terminal unavailable")
var ErrDenied = errors.New("denied by user")

type Prompter interface {
	Available() bool
	Ask(context.Context, string) (string, error)
	Run(context.Context, []string) error
}
type Coordinator struct {
	p        Prompter
	slot     chan struct{}
	mu       sync.Mutex
	busy     bool
	queued   []queuedOutput
	buffered int
	dropped  io.Writer
}

func New(p Prompter) *Coordinator      { return &Coordinator{p: p, slot: make(chan struct{}, 1)} }
func (c *Coordinator) Available() bool { return c != nil && c.p != nil && c.p.Available() }
func (c *Coordinator) enter(ctx context.Context) error {
	if !c.Available() {
		return ErrUnavailable
	}
	select {
	case c.slot <- struct{}{}:
		if e := ctx.Err(); e != nil {
			<-c.slot
			return e
		}
		c.mu.Lock()
		c.busy = true
		c.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (c *Coordinator) Ask(ctx context.Context, text string) (string, error) {
	if e := c.enter(ctx); e != nil {
		return "", e
	}
	defer c.leave()
	return c.p.Ask(ctx, text)
}
func (c *Coordinator) Run(ctx context.Context, argv []string) error {
	if e := c.enter(ctx); e != nil {
		return e
	}
	defer c.leave()
	return c.p.Run(ctx, argv)
}

// Output keeps live events off an active terminal prompt. Audits remain durable;
// only terminal presentation is buffered, with a fixed 64 KiB bound.
func (c *Coordinator) Output(w io.Writer) io.Writer {
	if c == nil {
		return w
	}
	return coordinatedOutput{c, w}
}

type queuedOutput struct {
	w    io.Writer
	data []byte
}
type coordinatedOutput struct {
	c *Coordinator
	w io.Writer
}

func (w coordinatedOutput) Write(b []byte) (int, error) {
	c := w.c
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.busy {
		return w.w.Write(b)
	}
	if len(b) <= (64<<10)-c.buffered {
		c.queued = append(c.queued, queuedOutput{w.w, append([]byte(nil), b...)})
		c.buffered += len(b)
	} else {
		c.dropped = w.w
	}
	return len(b), nil
}
func (c *Coordinator) leave() {
	c.mu.Lock()
	if len(c.queued) > 0 {
		_, _ = io.WriteString(c.queued[0].w, "\n")
	}
	for _, v := range c.queued {
		_, _ = v.w.Write(v.data)
	}
	if c.dropped != nil {
		_, _ = io.WriteString(c.dropped, "\nTerminal event buffer full; use bridge-dev watch for durable audit entries.\n")
	}
	c.queued = nil
	c.buffered = 0
	c.dropped = nil
	c.busy = false
	c.mu.Unlock()
	<-c.slot
}
func (c *Coordinator) Confirm(ctx context.Context, text string) bool {
	a, e := c.Ask(ctx, text+" [y/N] ")
	return e == nil && strings.EqualFold(strings.TrimSpace(a), "y")
}
func Safe(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

type Terminal struct{ f *os.File }

func Open() *Terminal { f, _ := os.OpenFile("/dev/tty", os.O_RDWR, 0); return &Terminal{f: f} }
func (t *Terminal) Close() {
	if t.f != nil {
		_ = t.f.Close()
	}
}
func (t *Terminal) Available() bool { return t != nil && t.f != nil }
func (t *Terminal) Ask(ctx context.Context, text string) (string, error) {
	if !t.Available() {
		return "", ErrUnavailable
	}
	flushInput(int(t.f.Fd()))
	if _, e := fmt.Fprint(t.f, text); e != nil {
		return "", e
	}
	defer flushInput(int(t.f.Fd()))
	defer func() {
		if ctx.Err() != nil {
			_, _ = fmt.Fprintln(t.f)
		}
	}()
	var out strings.Builder
	for {
		if e := ctx.Err(); e != nil {
			return "", e
		}
		wait := 100
		if d, ok := ctx.Deadline(); ok {
			wait = min(wait, max(1, int(time.Until(d).Milliseconds())))
		}
		fds := []unix.PollFd{{Fd: int32(t.f.Fd()), Events: unix.POLLIN}}
		n, e := unix.Poll(fds, wait)
		if e == unix.EINTR {
			continue
		}
		if e != nil {
			return "", e
		}
		if n == 0 {
			continue
		}
		var b [1]byte
		n, e = unix.Read(int(t.f.Fd()), b[:])
		if e == unix.EINTR {
			continue
		}
		if e != nil {
			return "", e
		}
		if n == 0 {
			return "", ErrUnavailable
		}
		if b[0] == '\n' {
			return strings.TrimSpace(out.String()), nil
		}
		if out.Len() >= 4096 {
			return "", errors.New("terminal input too long")
		}
		out.WriteByte(b[0])
	}
}

// Run connects the TTY directly to the executable. In particular, sudo reads
// its own password; Bridge never scans or captures this input/output.
func (t *Terminal) Run(ctx context.Context, argv []string) error {
	if !t.Available() || len(argv) == 0 {
		return ErrUnavailable
	}
	c := exec.CommandContext(ctx, argv[0], argv[1:]...)
	c.Stdin = t.f
	c.Stdout = t.f
	c.Stderr = t.f
	return c.Run()
}
