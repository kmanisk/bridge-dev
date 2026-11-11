package fsjail

import (
	"crypto/rand"
	"encoding/hex"
	"golang.org/x/sys/unix"
	"os"
)

// replace writes a fresh inode then renames within a pinned parent directory.
// Existing hard links cannot turn a concurrent write into outside-root mutation.
func replace(parent *os.File, base string, b []byte, mode os.FileMode) error {
	r := make([]byte, 16)
	if _, e := rand.Read(r); e != nil {
		return e
	}
	tmp := ".bridge-write-" + hex.EncodeToString(r)
	dfd := int(parent.Fd())
	fd, e := unix.Openat(dfd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if e != nil {
		return e
	}
	defer unix.Unlinkat(dfd, tmp, 0)
	f := os.NewFile(uintptr(fd), tmp)
	defer f.Close()
	if _, e = f.Write(b); e != nil {
		return e
	}
	if e = f.Chmod(mode.Perm() & 0777); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = unix.Renameat(dfd, tmp, dfd, base); e != nil {
		return e
	}
	return parent.Sync()
}
