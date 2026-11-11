package policy

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"
)

type Mode string

const (
	Readonly  Mode = "readonly"
	User      Mode = "user"
	Sudo      Mode = "sudo"
	Dangerous Mode = "dangerous"
)

func (m Mode) Validate(remote bool) error {
	switch m {
	case Readonly, User, Sudo, Dangerous:
		return nil
	}
	return errors.New("invalid permission mode")
}
func (m Mode) Write() bool      { return m == User || m == Sudo || m == Dangerous }
func (m Mode) Privileged() bool { return m == Sudo || m == Dangerous }

// Commands are explicit absolute executable paths. Allowing an interpreter or a
// general-purpose program grants its full capabilities; this is not a sandbox.
type Commands struct {
	Allow     []string
	Deny      []string
	SudoAllow []string
}

func (p Commands) Check(argv []string, sudo bool, dangerous bool) error {
	if len(argv) > 256 {
		return errors.New("argv limit exceeded")
	}
	total := 0
	for _, a := range argv {
		total += len(a)
		if strings.ContainsRune(a, 0) {
			return errors.New("NUL in argv")
		}
	}
	if total > 64<<10 {
		return errors.New("argv byte limit exceeded")
	}
	if len(argv) == 0 || !filepath.IsAbs(argv[0]) || filepath.Clean(argv[0]) != argv[0] {
		return errors.New("argv requires a clean absolute executable path")
	}
	if dangerous {
		return nil
	}
	if slices.Contains(p.Deny, argv[0]) {
		return errors.New("command denied")
	}
	if sudo {
		if p.SudoAllow != nil && !slices.Contains(p.SudoAllow, argv[0]) {
			return errors.New("command not sudo-allowlisted")
		}
		return nil
	}
	if !dangerous && !slices.Contains(p.Allow, argv[0]) {
		return errors.New("command not allowlisted")
	}
	return nil
}
