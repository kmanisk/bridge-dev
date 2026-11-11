package fsjail

import (
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestJail(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret")
	os.WriteFile(secret, []byte("outside"), 0600)
	os.Symlink(outside, filepath.Join(root, "escape"))
	j, e := New([]string{root})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	for _, p := range []string{"../secret", secret, "escape/secret"} {
		if _, e = j.Read(p, 100); e == nil {
			t.Fatal(p)
		}
		if e = j.Write(p, []byte("bad")); e == nil {
			t.Fatal(p)
		}
	}
	if e = j.Write("ok", []byte("hello")); e != nil {
		t.Fatal(e)
	}
	b, e := j.Read("ok", 100)
	if e != nil || string(b) != "hello" {
		t.Fatal(string(b), e)
	}
	if _, e = j.Read("ok", 2); e == nil {
		t.Fatal("limit")
	}
	os.Link(secret, filepath.Join(root, "hard"))
	if e = j.Write("hard", []byte("bad")); e == nil {
		t.Fatal("hardlink")
	}
	unix.Mkfifo(filepath.Join(root, "pipe"), 0600)
	if _, e = j.Read("pipe", 10); e == nil {
		t.Fatal("fifo")
	}
	if e = j.Write("pipe", nil); e == nil {
		t.Fatal("fifo write")
	}
	if e = j.Edit("ok", "hello", "world"); e != nil {
		t.Fatal(e)
	}
	if e = j.Edit("ok", "missing", "no"); e == nil {
		t.Fatal("edit precondition")
	}
}
func TestConcurrentReplacement(t *testing.T) {
	root := t.TempDir()
	outer := t.TempDir()
	os.WriteFile(filepath.Join(outer, "secret"), []byte("outside"), 0600)
	os.Mkdir(filepath.Join(root, "swap"), 0700)
	j, e := New([]string{root})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			os.Remove(filepath.Join(root, "swap"))
			os.Symlink(outer, filepath.Join(root, "swap"))
			os.Remove(filepath.Join(root, "swap"))
		}
	}()
	for i := 0; i < 1000; i++ {
		b, e := j.Read("swap/secret", 100)
		if e == nil && string(b) == "outside" {
			t.Fatal("escaped")
		}
		_ = j.Write("swap/secret", []byte("changed"))
	}
	wg.Wait()
	b, _ := os.ReadFile(filepath.Join(outer, "secret"))
	if string(b) != "outside" {
		t.Fatal("write escaped")
	}
}
func FuzzPaths(f *testing.F) {
	for _, s := range []string{".", "../x", "/etc/passwd", "a/../../b", "link/x", "a\x00b"} {
		f.Add(s)
	}
	r := f.TempDir()
	outside := f.TempDir()
	os.WriteFile(filepath.Join(outside, "secret"), []byte("outside"), 0600)
	os.WriteFile(filepath.Join(r, "safe"), []byte("inside"), 0600)
	os.Symlink(outside, filepath.Join(r, "link"))
	f.Add("safe")
	f.Add(filepath.Join(outside, "secret"))
	j, e := New([]string{r})
	if e != nil {
		f.Fatal(e)
	}
	defer j.Close()
	f.Fuzz(func(t *testing.T, s string) {
		b, e := j.Read(s, 32)
		if e == nil && string(b) != "inside" {
			t.Fatalf("unexpected accessible data for %q: %q", s, b)
		}
	})
}

func TestPermissionFailures(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root bypasses file permissions")
	}
	root := t.TempDir()
	p := filepath.Join(root, "protected")
	os.WriteFile(p, []byte("private"), 0000)
	j, e := New([]string{root})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	defer os.Chmod(p, 0600)
	if _, e = j.Read("protected", 100); e == nil {
		t.Fatal("read permission bypass")
	}
	if e = j.Write("protected", []byte("new")); e == nil {
		t.Fatal("write permission bypass")
	}
}
