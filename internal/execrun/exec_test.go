package execrun

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestExec(t *testing.T) {
	root := t.TempDir()
	j, e := fsjail.New([]string{root})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	p := policy.Commands{Allow: []string{"/bin/echo", "/bin/sh"}, Deny: []string{"/bin/rm"}}
	r, e := Run(context.Background(), j, p, policy.User, Request{Argv: []string{"/bin/echo", "$(oops)"}, Cwd: root}, false, nil)
	if e != nil || strings.TrimSpace(r.Output) != "$(oops)" {
		t.Fatal(r, e)
	}
	for _, a := range [][]string{{"echo"}, {"/bin/rm"}, {"/bin/cat"}} {
		if _, e = Run(context.Background(), j, p, policy.User, Request{Argv: a, Cwd: root}, false, nil); e == nil {
			t.Fatal(a)
		}
	}
	r, e = Run(context.Background(), j, p, policy.User, Request{Argv: []string{"/bin/sh", "-c", "yes x | head -c 2000000; exit 7"}, Cwd: root}, false, nil)
	if e != nil || r.ExitCode != 7 || !r.Truncated || len(r.Output) != MaxOutput {
		t.Fatal(r.ExitCode, len(r.Output), e)
	}
	r, e = Run(context.Background(), j, p, policy.User, Request{Argv: []string{"/bin/sh", "-c", "sleep 30"}, Cwd: root, TimeoutSeconds: 1}, false, nil)
	if e != nil || !r.TimedOut || r.Signal == "" {
		t.Fatal(r, e)
	}
}
func TestFakeSudo(t *testing.T) {
	p := filepath.Join(t.TempDir(), "fake-sudo")
	os.WriteFile(p, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0700)
	a := SudoArgv(p, []string{"/bin/echo", "safe"})
	if !reflect.DeepEqual(a, []string{p, "-n", "--", "/bin/echo", "safe"}) {
		t.Fatal(a)
	}
	j, _ := fsjail.New([]string{filepath.Dir(p)})
	defer j.Close()
	r, e := Run(context.Background(), j, policy.Commands{Allow: []string{p}}, policy.User, Request{Argv: a, Cwd: filepath.Dir(p)}, false, nil)
	if e != nil || r.Output != "-n\n--\n/bin/echo\nsafe\n" {
		t.Fatal(r, e)
	}
}
func TestEnvironment(t *testing.T) {
	t.Setenv("SECRET_TOKEN", "hidden")
	t.Setenv("LANG", "C")
	for _, v := range Environment([]string{"LANG", "LD_PRELOAD"}) {
		if strings.Contains(v, "hidden") {
			t.Fatal(v)
		}
	}
}

func TestForcedGroupTermination(t *testing.T) {
	root := t.TempDir()
	j, e := fsjail.New([]string{root})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	r, e := Run(context.Background(), j, policy.Commands{Allow: []string{"/bin/sh"}}, policy.User, Request{Argv: []string{"/bin/sh", "-c", "trap '' TERM; while :; do sleep 1; done"}, Cwd: root, TimeoutSeconds: 1}, false, nil)
	if e != nil || !r.TimedOut || r.Signal != "killed" {
		t.Fatal(r, e)
	}
}

func TestDirectPrivilegeBrokerDenied(t *testing.T) {
	root := t.TempDir()
	j, e := fsjail.New([]string{root})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	for _, path := range []string{"/usr/bin/sudo", "/usr/bin/doas", "/usr/bin/pkexec"} {
		if _, _, e = Prepare(j, policy.Commands{Allow: []string{path}}, policy.User, Request{Argv: []string{path}, Cwd: root}, false); e == nil {
			t.Fatal("direct broker allowed", path)
		}
	}
}

func TestSudoOwnContext(t *testing.T) {
	dir := t.TempDir()
	fake := filepath.Join(dir, "sudo")
	os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 1\n"), 0700)
	t.Setenv("PATH", dir)
	j, e := fsjail.New([]string{dir})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	r, e := Run(context.Background(), j, policy.Commands{}, policy.Sudo, Request{Argv: []string{"/usr/bin/id"}, Cwd: dir}, true, nil)
	if e != nil || r.ExitCode != 1 || !strings.Contains(r.Output, "-n\n--\n/usr/bin/id") {
		t.Fatal(r, e)
	}
	if e = SudoAvailable(context.Background()); e == nil {
		t.Fatal("cold context accepted")
	}
}

func TestConfiguredAndUnlimitedOutput(t *testing.T) {
	dir := t.TempDir()
	j, e := fsjail.New([]string{dir})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	for _, limit := range []int{3, 0} {
		r, e := RunWithLimits(context.Background(), j, policy.Commands{}, policy.Dangerous, Request{Argv: []string{"/bin/echo", "abcdef"}, Cwd: dir}, false, nil, limit, 0, 0)
		if e != nil {
			t.Fatal(e)
		}
		if limit == 3 && (!r.Truncated || r.Output != "abc") || limit == 0 && (r.Truncated || r.Output != "abcdef\n") {
			t.Fatal(r)
		}
	}
}
