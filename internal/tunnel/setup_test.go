package tunnel

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type script struct {
	answers  []string
	commands [][]string
}

func (s *script) Available() bool { return true }
func (s *script) Ask(context.Context, string) (string, error) {
	a := s.answers[0]
	s.answers = s.answers[1:]
	return a, nil
}
func (s *script) Run(_ context.Context, a []string) error {
	s.commands = append(s.commands, a)
	return nil
}
func TestNamedSetupAndQuickReset(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "cloudflared"), []byte("#!/bin/sh\nexit 99\n"), 0700)
	t.Setenv("PATH", dir)
	c := config.Defaults()
	c.Roots = []string{dir}
	c.StateDir = filepath.Join(dir, "state")
	c.ConfigFile = filepath.Join(dir, "config", "config.toml")
	p := &script{answers: []string{"named", "bridge-fixture", "mcp.example.com", "y"}}
	if e := Setup(context.Background(), c, prompt.New(p), io.Discard); e != nil {
		t.Fatal(e)
	}
	if len(p.commands) != 3 || p.commands[0][2] != "login" || p.commands[2][2] != "route" {
		t.Fatal(p.commands)
	}
	c, e := config.Load([]string{"--config", c.ConfigFile}, func(string) string { return "" })
	if e != nil || c.TunnelName != "bridge-fixture" || c.PublicOrigin != "https://mcp.example.com" {
		t.Fatal(c, e)
	}
	p = &script{answers: []string{"quick"}}
	if e = Setup(context.Background(), c, prompt.New(p), io.Discard); e != nil {
		t.Fatal(e)
	}
	c, e = config.Load([]string{"--config", c.ConfigFile}, func(string) string { return "" })
	if e != nil || c.TunnelName != "" || c.PublicOrigin != "" || len(p.commands) != 0 {
		t.Fatal(c, e)
	}
}
