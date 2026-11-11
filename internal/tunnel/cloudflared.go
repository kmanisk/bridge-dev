// Package tunnel owns only its explicitly launched outbound cloudflared child.
package tunnel

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kmanisk/bridge-dev/internal/execrun"
)

var hostname = regexp.MustCompile(`https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com`)

type Tunnel struct {
	URL            string
	cancel         context.CancelFunc
	done           chan struct{}
	registered     chan struct{}
	registeredOnce sync.Once
	once           sync.Once
	mu             sync.RWMutex
	state          string
	exitErr        error
	recentLogs     []string
}

func (t *Tunnel) Done() <-chan struct{} { return t.done }

func (t *Tunnel) Registered() <-chan struct{} { return t.registered }

func (t *Tunnel) WaitRegistered(ctx context.Context, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-t.registered:
		return true
	case <-t.done:
		return false
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func (t *Tunnel) IsDone() bool {
	select {
	case <-t.done:
		return true
	default:
		return false
	}
}

func (t *Tunnel) State() string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.state != "" {
		return t.state
	}
	select {
	case <-t.done:
		if t.exitErr != nil {
			return fmt.Sprintf("exited (%v)", t.exitErr)
		}
		return "exited"
	default:
		return "running"
	}
}

func (t *Tunnel) RecentLogs() []string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return append([]string(nil), t.recentLogs...)
}

func (t *Tunnel) LastError() string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.exitErr != nil {
		return t.exitErr.Error()
	}
	if len(t.recentLogs) > 0 {
		return t.recentLogs[len(t.recentLogs)-1]
	}
	return ""
}

func (t *Tunnel) Close() { t.once.Do(func() { t.cancel(); <-t.done }) }

func (t *Tunnel) appendLog(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.recentLogs) >= 20 {
		t.recentLogs = t.recentLogs[1:]
	}
	t.recentLogs = append(t.recentLogs, line)
	if strings.Contains(line, "Registered tunnel connection") || strings.Contains(line, "registered connIndex=") {
		t.state = "registered"
		t.registeredOnce.Do(func() {
			close(t.registered)
		})
	}
}

func Start(ctx context.Context, binary, local string) (*Tunnel, error) {
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.Command(binary, "tunnel", "--url", local, "--no-autoupdate")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stderr, e := cmd.StderrPipe()
	if e != nil {
		cancel()
		return nil, e
	}
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		cancel()
		return nil, e
	}
	if e = cmd.Start(); e != nil {
		cancel()
		return nil, e
	}
	t := &Tunnel{cancel: cancel, done: make(chan struct{}), registered: make(chan struct{}), state: "starting"}
	lines := make(chan string, 128)
	var readersWg sync.WaitGroup
	scan := func(r io.Reader) {
		defer readersWg.Done()
		s := bufio.NewScanner(r)
		s.Buffer(make([]byte, 4096), 64<<10)
		for s.Scan() {
			lines <- s.Text()
		}
	}
	readersWg.Add(2)
	go scan(stderr)
	go scan(stdout)
	go func() {
		readersWg.Wait()
		close(lines)
	}()

	urls := make(chan string, 1)
	go func() {
		for line := range lines {
			t.appendLog(line)
			if u := ParseURL(line); u != "" {
				select {
				case urls <- u:
				default:
				}
			}
		}
	}()

	go func() {
		err := execrun.WaitCommand(ctx, cmd)
		t.mu.Lock()
		t.exitErr = err
		if err != nil {
			t.state = fmt.Sprintf("exited (%v)", err)
		} else {
			t.state = "exited"
		}
		t.mu.Unlock()
		close(t.done)
	}()

	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case t.URL = <-urls:
		t.mu.Lock()
		if t.state == "starting" {
			t.state = "url announced"
		}
		t.mu.Unlock()
		return t, nil
	case <-t.done:
		select {
		case t.URL = <-urls:
			t.mu.Lock()
			if t.state == "starting" {
				t.state = "url announced"
			}
			t.mu.Unlock()
			return t, nil
		default:
		}
		cancel()
		state := t.State()
		return nil, fmt.Errorf("cloudflared %s before announcing a Quick Tunnel URL", state)
	case <-timer.C:
		cancel()
		<-t.done
		return nil, errors.New("cloudflared URL timeout")
	case <-ctx.Done():
		cancel()
		<-t.done
		return nil, ctx.Err()
	}
}

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
