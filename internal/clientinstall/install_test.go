package clientinstall

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/pelletier/go-toml/v2"
)

type yes struct{ answer string }

func (y yes) Available() bool                             { return true }
func (y yes) Ask(context.Context, string) (string, error) { return y.answer, nil }
func (y yes) Run(context.Context, []string) error         { return nil }
func setup(t *testing.T) (config.Config, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("CODEX_HOME", filepath.Join(dir, "codex-home"))
	os.Mkdir(filepath.Join(dir, "codex-home"), 0700)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	c := config.Defaults()
	c.StateDir = filepath.Join(dir, "state")
	c.Roots = []string{filepath.Join(dir, "root")}
	os.Mkdir(c.Roots[0], 0700)
	c.Mode = policy.User
	return c, dir
}
func TestFakeInstallUninstall(t *testing.T) {
	for _, client := range []string{"codex", "claude-code"} {
		t.Run(client, func(t *testing.T) {
			c, dir := setup(t)
			path, e := configPath(client)
			if e != nil {
				t.Fatal(e)
			}
			os.MkdirAll(filepath.Dir(path), 0700)
			binary, _ := os.Executable()
			entry := Entry{binary, []string{"stdio", "--config", filepath.Join(c.StateDir, "install", client+".toml"), "--roots", strings.Join(c.Roots, ","), "--mode", "user"}}
			other := map[string]any{"command": "/unrelated", "args": []string{"unchanged"}}
			key := "mcpServers"
			if client == "codex" {
				key = "mcp_servers"
			}
			encode := func(v any) []byte {
				var b []byte
				if client == "codex" {
					b, _ = toml.Marshal(v)
				} else {
					b, _ = json.Marshal(v)
				}
				return b
			}
			before := encode(map[string]any{key: map[string]any{"other": other}})
			eb, _ := json.Marshal(entry)
			var em map[string]any
			json.Unmarshal(eb, &em)
			after := encode(map[string]any{key: map[string]any{"other": other, identity.Binary: em}})
			os.WriteFile(path, before, 0600)
			base := filepath.Join(dir, "before")
			added := filepath.Join(dir, "after")
			os.WriteFile(base, before, 0600)
			os.WriteFile(added, after, 0600)
			name := "codex"
			if client == "claude-code" {
				name = "claude"
			}
			fake := filepath.Join(dir, name)
			os.WriteFile(fake, []byte("#!/bin/sh\ncase \"$2\" in add) /bin/cp '"+added+"' '"+path+"';; remove) /bin/cp '"+base+"' '"+path+"';; *) exit 1;; esac\n"), 0700)
			t.Setenv("PATH", dir)
			var out bytes.Buffer
			if e = Run(context.Background(), c, client, false, prompt.New(yes{"N"}), &out); e == nil {
				t.Fatal("denial ignored")
			}
			if b, _ := os.ReadFile(path); !bytes.Equal(b, before) {
				t.Fatal("denied mutation")
			}
			if e = Run(context.Background(), c, client, false, prompt.New(yes{"y"}), &out); e != nil {
				t.Fatal(e)
			}
			if e = Run(context.Background(), c, client, false, prompt.New(nil), &out); e != nil {
				t.Fatal("idempotency", e)
			}
			current, _ := readEntry(client, path)
			current["changed"] = true
			changed := encode(map[string]any{key: map[string]any{"other": other, identity.Binary: current}})
			os.WriteFile(path, changed, 0600)
			if e = Run(context.Background(), c, client, true, prompt.New(yes{"y"}), &out); e == nil {
				t.Fatal("modified registration removed")
			}
			os.WriteFile(path, after, 0600)
			if e = Run(context.Background(), c, client, true, prompt.New(yes{"y"}), &out); e != nil {
				t.Fatal(e)
			}
			if b, _ := os.ReadFile(path); !bytes.Equal(b, before) {
				t.Fatal("unrelated registration changed")
			}
		})
	}
}
func TestPrintAndDesktop(t *testing.T) {
	c, dir := setup(t)
	c.Print = true
	for _, client := range []string{"codex", "claude-code", "claude-desktop"} {
		var out bytes.Buffer
		if e := Run(context.Background(), c, client, false, prompt.New(nil), &out); e != nil || !strings.Contains(out.String(), "stdio") {
			t.Fatal(out.String(), e)
		}
	}
	if _, e := os.Stat(filepath.Join(dir, "state")); !os.IsNotExist(e) {
		t.Fatal("print wrote state")
	}
}
func TestNativeIsolatedCodex(t *testing.T) {
	codex, e := exec.LookPath("codex")
	if e != nil {
		t.Skip("Codex not installed")
	}
	c, dir := setup(t)
	fake := filepath.Join(dir, "bin")
	os.Mkdir(fake, 0700)
	os.Symlink(codex, filepath.Join(fake, "codex"))
	os.WriteFile(filepath.Join(fake, "sudo"), []byte("#!/bin/sh\nexit 99\n"), 0700)
	t.Setenv("PATH", fake+":"+os.Getenv("PATH"))
	var out bytes.Buffer
	if e = Run(context.Background(), c, "codex", false, prompt.New(yes{"y"}), &out); e != nil {
		t.Fatal(out.String(), e)
	}
	if e = exec.Command(codex, "mcp", "get", identity.Binary, "--json").Run(); e != nil {
		t.Fatal(e)
	}
	if e = Run(context.Background(), c, "codex", true, prompt.New(yes{"y"}), &out); e != nil {
		t.Fatal(e)
	}
}
