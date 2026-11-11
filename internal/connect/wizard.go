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
		ask := func(text, current string, validate func(string) error) (string, error) {
			for {
				a, e := p.Ask(ctx, text+" ["+current+"]: ")
				if a == "" {
					a = current
				}
				if e != nil {
					return "", e
				}
				a = strings.TrimSpace(a)
				if e = validate(a); e != nil {
					fmt.Fprintln(out, e)
					continue
				}
				return a, nil
			}
		}
		roots, e := ask("Allowed roots (comma separated)", strings.Join(c.Roots, ","), validateRoots)
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
		mode, e := ask("Mode", string(c.Mode), func(v string) error {
			if policy.Mode(v).Validate(false) != nil {
				return errors.New("invalid mode. Choose readonly, user, sudo or dangerous")
			}
			return nil
		})
		if e != nil {
			return c, e
		}
		c.Mode = policy.Mode(mode)
		approve, e := ask("Approval policy: none, sudo, write, all", defaultApproval(c), func(v string) error {
			switch v {
			case "none", "sudo", "write", "all":
				return nil
			}
			return errors.New("invalid approval policy. Choose none, sudo, write or all")
		})
		if e != nil {
			return c, e
		}
		c.Approve = approve
		c.Idle, e = ask("Idle timeout", c.Idle, func(v string) error {
			d, e := time.ParseDuration(v)
			if e != nil || d <= 0 {
				return errors.New("invalid idle timeout. Enter a positive duration such as 30m")
			}
			return nil
		})
		if e != nil {
			return c, e
		}
		c.Tunnel, e = ask("Tunnel: cloudflared, none, custom:executable", c.Tunnel, func(v string) error {
			copy := c
			copy.Tunnel = v
			if v != "cloudflared" && v != "none" && (!strings.HasPrefix(v, "custom:") || strings.TrimPrefix(v, "custom:") == "") {
				return errors.New("invalid tunnel. Choose cloudflared, none or custom:executable")
			}
			return Doctor(copy, exec.LookPath)
		})
		if e != nil {
			return c, e
		}
		if c.Mode.Write() && c.Mode != policy.Dangerous {
			a, e := ask("Allowed user executables (comma separated; none clears)", strings.Join(c.Allow, ","), validateCommands)
			if e != nil {
				return c, e
			}
			if a == "none" || a == "" {
				c.Allow = nil
			} else {
				c.Allow = strings.Split(a, ",")
				for i := range c.Allow {
					c.Allow[i] = strings.TrimSpace(c.Allow[i])
				}
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

func validateRoots(value string) error {
	var paths []string
	for _, v := range strings.Split(value, ",") {
		v = strings.TrimSpace(v)
		if v == "" {
			return errors.New("invalid roots: enter one or more directory paths")
		}
		paths = append(paths, v)
	}
	j, e := fsjail.New(paths)
	if e != nil {
		return fmt.Errorf("invalid roots: %w", e)
	}
	defer j.Close()
	if e = j.Check(); e != nil {
		return fmt.Errorf("roots cannot be safely opened: %w", e)
	}
	return nil
}
func validateCommands(value string) error {
	if value == "none" || value == "" {
		return nil
	}
	for _, v := range strings.Split(value, ",") {
		v = strings.TrimSpace(v)
		if !filepath.IsAbs(v) || filepath.Clean(v) != v || strings.ContainsRune(v, 0) {
			return errors.New("invalid command: use clean absolute executable paths or none")
		}
	}
	return nil
}
