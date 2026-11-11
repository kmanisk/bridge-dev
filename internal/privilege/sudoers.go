package privilege

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"github.com/kmanisk/bridge-dev/internal/prompt"
)

// Sudoers uses narrowly scoped no-argument rules, never broad wildcard defaults.
func Sudoers(ctx context.Context, user string, commands []string, install bool, p *prompt.Coordinator, out io.Writer) error {
	text, e := policy.SudoersPreview(user, commands)
	if e != nil {
		return e
	}
	visudo, e := exec.LookPath("visudo")
	if e != nil {
		return e
	}
	if e = policy.ValidateSudoers(text, visudo); e != nil {
		return e
	}
	fmt.Fprint(out, text)
	for _, path := range commands {
		switch filepath.Base(path) {
		case "sh", "bash", "fish", "zsh", "sudo", "env", "python", "python3", "perl", "ruby", "node", "systemd-run":
			fmt.Fprintln(out, "WARNING: this executable may grant unrestricted root execution even without arguments.")
		}
	}
	if !install {
		return nil
	}
	if !p.Available() {
		return prompt.ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	if !p.Confirm(ctx, "Install exactly this validated root NOPASSWD rule file?") {
		return prompt.ErrDenied
	}
	sudo, e := exec.LookPath("sudo")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp("", identity.Binary+"-sudoers-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.WriteString(text); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	// sudo owns authentication on the controlling terminal. install is invoked
	// with literal argv; destination is derived only from the validated username.
	dest := "/etc/sudoers.d/" + identity.Binary + "-" + user
	if strings.ContainsAny(user, "/\\") {
		return errors.New("invalid username")
	}
	binary, e := os.Executable()
	if e != nil {
		return e
	}
	_ = dest
	return p.Run(ctx, []string{sudo, "--", binary, "_sudoers-install", user, f.Name(), auth.Hash(text)})
}

// InstallValidated consumes one immutable snapshot, verifies its preview digest,
// and validates those exact bytes before atomically installing a read-only rule.
// The CLI supplies a fixed privileged destination and trusted visudo executable.
func InstallValidated(user, source, digest, base, visudo string) error {
	if _, e := policy.SudoersPreview(user, []string{"/usr/bin/id"}); e != nil {
		return e
	}
	f, e := os.Open(source)
	if e != nil {
		return e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 64<<10))
	if e != nil {
		return e
	}
	if len(b) >= 64<<10 || !auth.Equal(auth.Hash(string(b)), digest) {
		return errors.New("sudoers preview changed; refusing installation")
	}
	if e = policy.ValidateSudoers(string(b), visudo); e != nil {
		return e
	}
	path := filepath.Join(base, identity.Binary+"-"+user)
	if _, e = os.Lstat(path); e == nil {
		return errors.New("sudoers destination already exists; refusing overwrite")
	} else if !os.IsNotExist(e) {
		return e
	}

	tmp, e := os.CreateTemp(base, ".bridge-sudoers-")
	if e != nil {
		return e
	}
	defer os.Remove(tmp.Name())
	if _, e = tmp.Write(b); e == nil {
		e = tmp.Chmod(0440)
	}
	if e == nil {
		e = tmp.Sync()
	}
	ce := tmp.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	// Link creates the final directory entry without ever replacing an existing
	// administrator's rule, including a concurrent creation after Lstat.
	if e = os.Link(tmp.Name(), path); e != nil {
		return e
	}
	dir, e := os.Open(base)
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}
