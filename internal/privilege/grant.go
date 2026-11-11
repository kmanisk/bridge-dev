// Package privilege separates saved preferences from current startup authority.
package privilege

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"github.com/kmanisk/bridge-dev/internal/prompt"
)

func Authorize(ctx context.Context, c *config.Config, p *prompt.Coordinator, out io.Writer, remote bool) error {
	if !c.Mode.Privileged() {
		return nil
	}
	if remote && !c.OAuth {
		return errors.New("remote sudo/dangerous requires OAuth")
	}
	fmt.Fprintf(out, "WARNING: %s grants remote-capable privileged access; dangerous access can compromise all computer data.\n", c.Mode)
	if !c.AckPrivileged {
		if c.Detach || !p.Available() {
			return errors.New("privileged startup requires a terminal confirmation; only a manually configured ack_privileged=true bypasses the phrase")
		}
		check, cancel := context.WithTimeout(ctx, 120*time.Second)
		defer cancel()
		phrase := "AUTHORIZE " + strings.ToUpper(string(c.Mode))
		s, e := p.Ask(check, "Type "+phrase+" to authorize this startup: ")
		if e != nil {
			return e
		}
		if s != phrase {
			return prompt.ErrDenied
		}
	}
	if c.Mode.Privileged() && p.Available() && !c.Detach {
		sudo, e := exec.LookPath("sudo")
		if e != nil {
			return e
		}
		check, cancel := context.WithTimeout(ctx, 120*time.Second)
		defer cancel()
		if e = p.Run(check, []string{sudo, "-v"}); e != nil {
			return errors.New("sudo credential validation failed; no privileged session started")
		}
	}
	c.PrivilegedAuthorized = true
	return nil
}

type Grant struct {
	fallback policy.Mode
	mu       sync.Mutex
	mode     policy.Mode
	expires  time.Time
	expired  bool
	onExpire func()
}

func New(mode policy.Mode, d time.Duration, onExpire func()) *Grant {
	g := &Grant{mode: mode, onExpire: onExpire}
	if mode.Privileged() && d > 0 {
		g.expires = time.Now().Add(d)
	}
	return g
}
func (g *Grant) Mode() policy.Mode {
	g.mu.Lock()
	expire := g.mode.Privileged() && (!g.expires.IsZero() && !time.Now().Before(g.expires) || g.expired)
	first := expire && !g.expired
	if expire {
		g.expired = true
	}
	mode := g.mode
	if g.expired {
		mode = g.fallback
		if mode == "" {
			mode = policy.Readonly
		}
	}
	cb := g.onExpire
	g.mu.Unlock()
	if first && cb != nil {
		cb()
	}
	return mode
}
func (g *Grant) Expiry() time.Time { g.mu.Lock(); defer g.mu.Unlock(); return g.expires }
func (g *Grant) Revoke() {
	g.mu.Lock()
	g.expires = time.Now().Add(-time.Second)
	g.mu.Unlock()
	g.Mode()
}

func (g *Grant) SetFallback(mode policy.Mode) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if mode == policy.User || mode == policy.Readonly {
		g.fallback = mode
	}
}
