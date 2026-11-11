// Package platform contains local process and durable-state primitives.
package platform

import (
	"encoding/json"
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
)

func PrivateDir(p string) error {
	if e := os.MkdirAll(p, 0700); e != nil {
		return e
	}
	s, e := os.Lstat(p)
	if e != nil {
		return e
	}
	if !s.IsDir() || s.Mode()&os.ModeSymlink != 0 || s.Mode().Perm()&0077 != 0 {
		return errors.New("state directory must be a private non-symlink directory (0700)")
	}
	return nil
}
func AtomicJSON(p string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return Atomic(p, b)
}
func Atomic(p string, b []byte) error {
	f, e := os.CreateTemp(filepath.Dir(p), ".pending-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(name, p); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(p))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func ReadJSON(p string, v any) error {
	b, e := os.ReadFile(p)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, v)
}
func Lock(p string) (func(), error) {
	f, e := os.OpenFile(p, os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW, 0600)
	if e != nil {
		return nil, e
	}
	if e = unix.Flock(int(f.Fd()), unix.LOCK_EX); e != nil {
		f.Close()
		return nil, e
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); _ = f.Close() }, nil
}
func TryLock(p string) (func(), error) {
	f, e := os.OpenFile(p, os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW, 0600)
	if e != nil {
		return nil, e
	}
	if e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		f.Close()
		return nil, e
	}
	return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); _ = f.Close() }, nil
}
