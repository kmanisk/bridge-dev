// Package tunnel owns only its explicitly launched outbound cloudflared child.
package tunnel

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"sync"
	"time"
)

var hostname = regexp.MustCompile(`https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com`)

type Tunnel struct {
	URL    string
	cancel context.CancelFunc
	done   <-chan struct{}
	once   sync.Once
}

func Start(ctx context.Context, binary, local string) (*Tunnel, error) {
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, binary, "tunnel", "--url", local, "--no-autoupdate")
	stderr, e := cmd.StderrPipe()
	if e != nil {
		cancel()
		return nil, e
	}
	cmd.Stdout = io.Discard
	if e = cmd.Start(); e != nil {
		cancel()
		return nil, e
	}
	urls := make(chan string, 1)
	scanDone := make(chan struct{})
	go func() {
		defer close(scanDone)
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 4096), 64<<10)
		for s.Scan() {
			if u := ParseURL(s.Text()); u != "" {
				select {
				case urls <- u:
				default:
				}
			}
		}
	}()
	done := make(chan struct{})
	go func() { <-scanDone; _ = cmd.Wait(); close(done) }()
	t := &Tunnel{cancel: cancel, done: done}
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case t.URL = <-urls:
		return t, nil
	case <-done:
		cancel()
		return nil, errors.New("cloudflared exited before announcing a Quick Tunnel URL")
	case <-timer.C:
		cancel()
		<-done
		return nil, errors.New("cloudflared URL timeout")
	case <-ctx.Done():
		cancel()
		<-done
		return nil, ctx.Err()
	}
}
func (t *Tunnel) Close() { t.once.Do(func() { t.cancel(); <-t.done }) }
func ParseURL(line string) string {
	loc := hostname.FindStringIndex(line)
	if loc == nil {
		return ""
	}
	if loc[1] < len(line) {
		c := line[loc[1]]
		if c == '.' || c == '-' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			return ""
		}
	}
	return line[loc[0]:loc[1]]
}

func (t *Tunnel) Done() <-chan struct{} { return t.done }
