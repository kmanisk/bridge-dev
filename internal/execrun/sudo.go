package execrun

import (
	"context"
	"errors"
	"os/exec"
	"time"
)

// SudoAvailable checks the worker's own context, never another terminal's cache.
func SudoAvailable(ctx context.Context) error {
	p, e := exec.LookPath("sudo")
	if e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if e = exec.CommandContext(ctx, p, "-n", "-v").Run(); e != nil {
		return errors.New("sudo credentials unavailable in this execution context; authenticate in its controlling terminal or explicitly configure scoped NOPASSWD rules; no password may be sent through MCP")
	}
	return nil
}
