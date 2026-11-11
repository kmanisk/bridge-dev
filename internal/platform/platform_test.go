package platform

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreAndOwnership(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if e := PrivateDir(dir); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(dir, "record.json")
	if e := AtomicJSON(path, map[string]string{"state": "durable"}); e != nil {
		t.Fatal(e)
	}
	var got map[string]string
	if e := ReadJSON(path, &got); e != nil || got["state"] != "durable" {
		t.Fatal(got, e)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0600 {
		t.Fatal(st.Mode())
	}
	release, e := TryLock(filepath.Join(dir, "lock"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = TryLock(filepath.Join(dir, "lock")); e == nil {
		t.Fatal("lock overlap")
	}
	release()
	link := filepath.Join(t.TempDir(), "link")
	os.Symlink(dir, link)
	if PrivateDir(link) == nil {
		t.Fatal("symlink state accepted")
	}
	bad := t.TempDir()
	os.Chmod(bad, 0755)
	if PrivateDir(bad) == nil {
		t.Fatal("public state accepted")
	}
}
func TestProcessIdentityAndListing(t *testing.T) {
	id, e := ProcessIdentity(os.Getpid())
	if e != nil || id == "" {
		t.Fatal(id, e)
	}
	again, e := ProcessIdentity(os.Getpid())
	if e != nil || id != again {
		t.Fatal("unstable identity", e)
	}
	if _, e = ProcessIdentity(-9999); e == nil {
		t.Fatal("invalid process accepted")
	}
	out, e := Processes(context.Background())
	if e != nil || !strings.Contains(out, "PID") || strings.Contains(out, "SECRET_TOKEN=") {
		t.Fatal(e)
	}
	w := &processOutput{}
	w.Write([]byte(strings.Repeat("x", 100000)))
	if w.b.Len() != 64<<10 {
		t.Fatal("process output unbounded")
	}
}
