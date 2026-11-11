package config

import (
	"github.com/kmanisk/bridge-dev/internal/policy"
	"os"
	"path/filepath"
	"testing"
)

func TestConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	empty := func(string) string { return "" }
	c, e := Load(nil, empty)
	if e != nil || c.Mode != policy.Readonly {
		t.Fatal(c, e)
	}
	p := filepath.Join(t.TempDir(), "config.toml")
	if e = os.WriteFile(p, []byte("mode = 'user'\nport = 4321\n"), 0600); e != nil {
		t.Fatal(e)
	}
	c, e = Load([]string{"--config", p, "--port", "6543"}, func(k string) string {
		if k == "BRIDGE_DEV_PORT" {
			return "5432"
		}
		return ""
	})
	if e != nil || c.Port != 6543 || c.Mode != policy.User {
		t.Fatal(c, e)
	}
	for _, args := range [][]string{{"--mode", "oops"}, {"--config", p + "missing"}, {"--idle-timeout", "0s"}, {"--tunnel", "cloudflared"}} {
		if _, e = Load(args, empty); e == nil {
			t.Fatal(args)
		}
	}
	if e = os.WriteFile(p, []byte("mod = 'dangerous'"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = Load([]string{"--config", p}, empty); e == nil {
		t.Fatal("unknown config accepted")
	}
}
