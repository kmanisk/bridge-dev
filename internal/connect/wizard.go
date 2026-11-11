package connect

import (
	"context"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func InstallHint(goos, osRelease string) string {
	if goos == "darwin" {
		return "brew install cloudflared"
	}
	if strings.Contains(osRelease, "arch") || strings.Contains(osRelease, "cachyos") {
		return "sudo pacman -S cloudflared"
	}
	if strings.Contains(osRelease, "fedora") || strings.Contains(osRelease, "rhel") {
		return "sudo dnf install cloudflared"
	}
	return "Install the official cloudflared package: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/"
}
func Doctor(c config.Config, look func(string) (string, error)) error {
	if c.Tunnel == "cloudflared" {
		if _, e := look("cloudflared"); e != nil {
			b, _ := os.ReadFile("/etc/os-release")
			return fmt.Errorf("cloudflared is missing; install it, then retry:\n  %s", InstallHint(runtime.GOOS, string(b)))
		}
	}
	if strings.HasPrefix(c.Tunnel, "custom:") {
		binary := strings.TrimPrefix(c.Tunnel, "custom:")
		if binary == "" {
			return errors.New("custom tunnel executable required")
		}
		if _, e := look(binary); e != nil {
			return errors.New("custom tunnel executable unavailable")
		}
	}
	return nil
}
func Prepare(ctx context.Context, args []string, getenv func(string) string, p *prompt.Coordinator, out io.Writer) (config.Config, error) {
	c, e := config.LoadConnect(args, getenv)
	if e != nil {
		return c, e
	}
	if e = Doctor(c, exec.LookPath); e != nil {
		return c, e
	}
	if !c.ConfigExists || c.Reconfigure {
		if !p.Available() {
			return c, errors.New("first-run/reconfigure wizard needs a terminal; provide configuration first")
		}
		fmt.Fprintln(out, "readonly: inspect files, processes and task records.\nuser: also write files and run authorized user commands/tasks.\nsudo: also run root commands and explicitly privileged tasks.\ndangerous: unrestricted paths and commands, optional shell and sudo.")
		ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		ask := func(text, current string) (string, error) {
			a, e := p.Ask(ctx, text+" ["+current+"]: ")
			if a == "" {
				a = current
			}
			return a, e
		}
		roots, e := ask("Allowed roots (comma separated)", strings.Join(c.Roots, ","))
		if e != nil {
			return c, e
		}
		c.Roots = strings.Split(roots, ",")
		for i, v := range c.Roots {
			c.Roots[i], e = filepath.Abs(strings.TrimSpace(v))
			if e != nil {
				return c, e
			}
		}
		mode, e := ask("Mode", string(c.Mode))
		if e != nil {
			return c, e
		}
		c.Mode = policy.Mode(mode)
		approve, e := ask("Approval policy: none, sudo, write, all", defaultApproval(c))
		if e != nil {
			return c, e
		}
		c.Approve = approve
		c.Idle, e = ask("Idle timeout", c.Idle)
		if e != nil {
			return c, e
		}
		c.Tunnel, e = ask("Tunnel: cloudflared, none, custom:executable", c.Tunnel)
		if e != nil {
			return c, e
		}
		if c.Mode.Write() {
			a, e := ask("Allowed user executables (comma separated; empty denies ordinary exec)", strings.Join(c.Allow, ","))
			if e != nil {
				return c, e
			}
			if a != "" {
				c.Allow = strings.Split(a, ",")
			}
		}
		c.OAuth = true
		if e = c.Validate(false); e != nil {
			return c, e
		}
		if c.Mode != policy.Dangerous {
			j, e := fsjail.New(c.Roots)
			if e != nil {
				return c, e
			}
			j.Close()
		}
		if e = Doctor(c, exec.LookPath); e != nil {
			return c, e
		}
		if e = config.Save(c); e != nil {
			return c, e
		}
		// Reapply original CLI/environment overrides to saved preferences.
		c, e = config.LoadConnect(args, getenv)
		if e != nil {
			return c, e
		}
	}
	if !c.OAuth {
		return c, errors.New("connect requires OAuth (auth selects terminal or pairing-code consent)")
	}
	return c, nil
}
func defaultApproval(c config.Config) string {
	if !c.ConfigExists {
		return "write"
	}
	return c.Approve
}
