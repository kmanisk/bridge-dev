package tunnel

import (
	"context"
	"errors"
	"github.com/kmanisk/bridge-dev/internal/config"
	"io"
	"net"
	"net/url"
	"os/exec"
	"strings"
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
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if e = cmd.Start(); e != nil {
		cancel()
		return nil, e
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	return &Tunnel{URL: c.PublicOrigin, cancel: cancel, done: done}, nil
}
