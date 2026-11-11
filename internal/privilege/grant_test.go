package privilege

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"github.com/kmanisk/bridge-dev/internal/prompt"
)

type script struct {
	answer string
	run    []string
}

func (s *script) Available() bool                             { return true }
func (s *script) Ask(context.Context, string) (string, error) { return s.answer, nil }
func (s *script) Run(_ context.Context, a []string) error     { s.run = a; return nil }
func TestStartup(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "sudo"), []byte("#!/bin/sh\nexit 93\n"), 0700)
	t.Setenv("PATH", dir)
	for _, mode := range []policy.Mode{policy.Sudo, policy.Dangerous} {
		c := config.Defaults()
		c.Mode = mode
		c.OAuth = true
		s := &script{answer: "wrong"}
		p := prompt.New(s)
		if e := Authorize(context.Background(), &c, p, io.Discard, true); e == nil {
			t.Fatal("bad phrase")
		}
		s.answer = "AUTHORIZE " + map[policy.Mode]string{policy.Sudo: "SUDO", policy.Dangerous: "DANGEROUS"}[mode]
		if e := Authorize(context.Background(), &c, p, io.Discard, true); e != nil || !c.PrivilegedAuthorized || len(s.run) != 2 || s.run[1] != "-v" {
			t.Fatal(e, s.run)
		}
		c.OAuth = false
		if e := Authorize(context.Background(), &c, p, io.Discard, true); e == nil {
			t.Fatal("bearer privilege")
		}
		c.OAuth = true
		c.Detach = true
		c.AckPrivileged = false
		if e := Authorize(context.Background(), &c, p, io.Discard, true); e == nil {
			t.Fatal("detached phrase")
		}
		c.AckPrivileged = true
		if e := Authorize(context.Background(), &c, prompt.New(nil), io.Discard, true); e != nil {
			t.Fatal(e)
		}
	}
}
func TestGrant(t *testing.T) {
	var expired atomic.Int32
	g := New(policy.Sudo, time.Millisecond, func() { expired.Add(1) })
	time.Sleep(3 * time.Millisecond)
	first := g.Mode()
	second := g.Mode()
	if first != policy.Readonly || second != policy.Readonly || expired.Load() != 1 {
		t.Fatal("expiry")
	}
	g = New(policy.Dangerous, 0, nil)
	g.Revoke()
	if g.Mode() != policy.Readonly {
		t.Fatal("origin revoke")
	}
}
func TestSudoersSnapshot(t *testing.T) {
	dir := t.TempDir()
	visudo := filepath.Join(dir, "visudo")
	os.WriteFile(visudo, []byte("#!/bin/sh\ntest \"$1\" = '-cf'\n"), 0700)
	source := filepath.Join(dir, "preview")
	text, _ := policy.SudoersPreview("testuser", []string{"/usr/bin/id"})
	os.WriteFile(source, []byte(text), 0600)
	dest := filepath.Join(dir, "dest")
	os.Mkdir(dest, 0700)
	if e := InstallValidated("testuser", source, auth.Hash(text), dest, visudo); e != nil {
		t.Fatal(e)
	}
	if e := InstallValidated("testuser", source, auth.Hash("changed"), dest, visudo); e == nil {
		t.Fatal("modified snapshot accepted")
	}
	if e := InstallValidated("testuser", source, auth.Hash(text), dest, visudo); e == nil {
		t.Fatal("existing overwritten")
	}
}
