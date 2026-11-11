package tunnel

import (
	"context"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"io"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`)

func Setup(ctx context.Context, c config.Config, p *prompt.Coordinator, out io.Writer) error {
	c.OAuth = true
	if !p.Available() {
		return prompt.ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	choice, e := p.Ask(ctx, "Tunnel: quick (no account) or named (Cloudflare account/domain required)? [quick] ")
	if e != nil {
		return e
	}
	if choice == "" || choice == "quick" {
		c.Tunnel = "cloudflared"
		c.TunnelName = ""
		c.PublicOrigin = ""
		if e = config.Save(c); e == nil {
			fmt.Fprintln(out, "Saved Quick Tunnel preference; no public tunnel started.")
		}
		return e
	}
	if choice != "named" {
		return errors.New("choose quick or named")
	}
	binary, e := exec.LookPath("cloudflared")
	if e != nil {
		return e
	}
	name, e := p.Ask(ctx, "Named tunnel name: ")
	if e != nil {
		return e
	}
	if !namePattern.MatchString(name) {
		return errors.New("invalid tunnel name")
	}
	host, e := p.Ask(ctx, "Public hostname (domain managed in your Cloudflare account): ")
	if e != nil {
		return e
	}
	host = strings.ToLower(strings.TrimSpace(host))
	origin := "https://" + host
	if e = ValidateOrigin(origin); e != nil {
		return e
	}
	u, _ := url.Parse(origin)
	if u.Port() != "" || strings.ContainsAny(host, "/\\ :\t\n") || !strings.Contains(host, ".") {
		return errors.New("a plain public DNS hostname is required")
	}
	fmt.Fprintln(out, "Cloudflare owns browser login and native credential files. Bridge does not read your Cloudflare password or credentials.")
	if !p.Confirm(ctx, "Run cloudflared login, create this named tunnel and route its DNS hostname?") {
		return prompt.ErrDenied
	}
	for _, args := range [][]string{{binary, "tunnel", "login"}, {binary, "tunnel", "create", name}, {binary, "tunnel", "route", "dns", name, host}} {
		if e = p.Run(ctx, args); e != nil {
			return errors.New("native cloudflared setup failed; inspect its output before retrying")
		}
	}
	c.Tunnel = "cloudflared"
	c.TunnelName = name
	c.PublicOrigin = origin
	if e = config.Save(c); e != nil {
		return e
	}
	fmt.Fprintln(out, "Saved named tunnel preference. Run connect to verify and start it; tunnel setup does not start a relay.")
	return nil
}
