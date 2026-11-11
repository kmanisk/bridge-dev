package tunnel

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/execrun"
	"io"
	"net"
	"net/url"
	"os/exec"
	"strings"
	"syscall"
)

func ValidateOrigin(origin string) error {
	u, e := url.Parse(origin)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("public origin must be an HTTPS origin without path, credentials, query or fragment")
	}
	if u.Hostname() == "localhost" {
		return errors.New("public origin cannot be localhost")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && (!ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()) {
		return errors.New("public origin must not be a local/private address")
	}
	return nil
}
func StartProvider(ctx context.Context, c config.Config, local string) (*Tunnel, error) {
	if c.Tunnel == "cloudflared" && c.TunnelName == "" {
		return Start(ctx, "cloudflared", local)
	}
	if e := ValidateOrigin(c.PublicOrigin); e != nil {
		return nil, e
	}
	var argv []string
	if c.Tunnel == "cloudflared" {
		argv = []string{"cloudflared", "tunnel", "--no-autoupdate", "run", "--url", local, c.TunnelName}
	} else if strings.HasPrefix(c.Tunnel, "custom:") {
		argv = append([]string{}, c.TunnelArgv...)
		binary := strings.TrimPrefix(c.Tunnel, "custom:")
		if len(argv) == 0 {
			argv = []string{binary, "{local_url}"}
		}
		if argv[0] != binary {
			return nil, errors.New("custom argv executable must match tunnel selection")
		}
	} else {
		return nil, errors.New("unsupported tunnel provider")
	}
	u, e := url.Parse(local)
	if e != nil {
		return nil, e
	}
	public, _ := url.Parse(c.PublicOrigin)
	for i, a := range argv {
		argv[i] = strings.NewReplacer("{local_url}", local, "{local_port}", u.Port(), "{public_host}", public.Hostname()).Replace(a)
	}
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.Command(argv[0], argv[1:]...)
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
	t := &Tunnel{URL: c.PublicOrigin, cancel: cancel, done: make(chan struct{}), state: "running"}
	go func() {
		s := bufio.NewScanner(io.MultiReader(stderr, stdout))
		for s.Scan() {
			t.appendLog(s.Text())
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
	return t, nil
}
