package policy

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var safeUser = regexp.MustCompile(`^[a-z_][a-z0-9_-]*\$?$`)
var safeCommand = regexp.MustCompile(`^/[a-zA-Z0-9_./-]+$`)

// SudoersPreview permits only no-argument forms. Additional argument scopes
// must be explicitly reviewed by a human; this function never installs rules.
func SudoersPreview(user string, paths []string) (string, error) {
	if !safeUser.MatchString(user) || len(paths) == 0 {
		return "", errors.New("valid user and command paths required")
	}
	var b strings.Builder
	b.WriteString("# Preview only. No-argument commands; review before manual installation.\n")
	for _, p := range paths {
		if !safeCommand.MatchString(p) || filepath.Clean(p) != p {
			return "", errors.New("unsupported sudoers command path")
		}
		fmt.Fprintf(&b, "%s ALL=(root) NOPASSWD: %s \"\"\n", user, p)
	}
	return b.String(), nil
}
func ValidateSudoers(text, visudo string) error {
	f, e := os.CreateTemp("", "bridge-sudoers-preview-")
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
	c := exec.Command(visudo, "-cf", f.Name())
	if e = c.Run(); e != nil {
		return errors.New("visudo -cf rejected preview")
	}
	return nil
}
