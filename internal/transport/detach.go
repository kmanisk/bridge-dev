package transport

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/platform"
)

func Detach(ctx context.Context, c config.Config) (string, error) {
	if runtime.GOOS != "linux" {
		return "", errors.New("detach requires a systemd Linux user manager")
	}
	if c.Auth == "code" && c.OAuth {
		return "", errors.New("detached code pairing would expose secrets in service logs; use foreground terminal OAuth")
	}
	if c.Mode.Privileged() && !c.AckPrivileged {
		return "", errors.New("detached privileged startup requires manually configured ack_privileged=true")
	}
	if e := platform.PrivateDir(c.StateDir); e != nil {
		return "", e
	}
	binary, e := os.Executable()
	if e != nil {
		return "", e
	}
	// Private standalone snapshot retains CLI overrides but never invents a privilege ack.
	c.ConfigFile = filepath.Join(c.StateDir, "detached-config.toml")
	if e = config.Save(c); e != nil {
		return "", e
	}
	unit := identity.Binary + "-http-" + fmt.Sprintf("%x", os.Getpid())
	args := []string{"--user", "--quiet", "--collect", "--service-type=exec", "--unit=" + unit, "--property=Restart=no", "--", binary, "up", "--headless", "--config", c.ConfigFile}
	if e = exec.CommandContext(ctx, "systemd-run", args...).Run(); e != nil {
		return "", errors.New("transient user unit could not start; check systemd user manager")
	}
	return unit, nil
}
