package config

import (
	"github.com/kmanisk/bridge-dev/internal/policy"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationReversibleAndNoGrant(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	p := filepath.Join(dir, "config.toml")
	original := []byte("mode = 'user'\nroots = ['/tmp']\n")
	os.WriteFile(p, original, 0600)
	c, e := Load([]string{"--config", p}, func(string) string { return "" })
	if e != nil || c.Schema != 1 {
		t.Fatal(c, e)
	}
	c.AckDanger = true
	c.PrivilegedAuthorized = true
	if e = Save(c); e != nil {
		t.Fatal(e)
	}
	next, e := Load([]string{"--config", p}, func(string) string { return "" })
	if e != nil || next.Schema != 2 || next.Mode != policy.User || next.AckDanger || next.PrivilegedAuthorized || next.AckPrivileged {
		t.Fatal(next, e)
	}
	s, _ := os.Stat(p)
	if s.Mode().Perm() != 0600 {
		t.Fatal(s.Mode())
	}
	matches, _ := filepath.Glob(p + ".pre-v2-*")
	if len(matches) != 1 {
		t.Fatal(matches)
	}
	if e = Restore(p, matches[0]); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(p)
	if string(b) != string(original) {
		t.Fatal(string(b))
	}
}
func TestPrivilegedPreferenceIsNotAuthorization(t *testing.T) {
	c, e := Load([]string{"--mode", "dangerous"}, func(string) string { return "" })
	if e != nil || c.PrivilegedAuthorized || c.AckPrivileged || c.Mode != policy.Dangerous {
		t.Fatal(c, e)
	}
}
