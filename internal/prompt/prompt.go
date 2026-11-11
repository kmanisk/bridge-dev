// Package prompt serializes all human interaction on the controlling terminal.
package prompt

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
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
	p    Prompter
	slot chan struct{}
}

func New(p Prompter) *Coordinator      { return &Coordinator{p: p, slot: make(chan struct{}, 1)} }
func (c *Coordinator) Available() bool { return c != nil && c.p != nil && c.p.Available() }
func (c *Coordinator) enter(ctx context.Context) error {
	if !c.Available() {
		return ErrUnavailable
	}
	select {
	case c.slot <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (c *Coordinator) Ask(ctx context.Context, text string) (string, error) {
	if e := c.enter(ctx); e != nil {
		return "", e
	}
	defer func() { <-c.slot }()
	return c.p.Ask(ctx, text)
}
func (c *Coordinator) Run(ctx context.Context, argv []string) error {
	if e := c.enter(ctx); e != nil {
		return e
	}
	defer func() { <-c.slot }()
	return c.p.Run(ctx, argv)
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
