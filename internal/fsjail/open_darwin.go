//go:build darwin

package fsjail

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func secureOpen(r entry, p string, write, create bool) (*os.File, error) {
	// os.Root on Darwin uses descriptor-relative traversal. Refuse links and
	// special files before and after open. Device creation/mount changes by a
	// same-user/root adversary are outside this backend's threat boundary.
	s, e := r.root.Lstat(p)
	if !r.unrestricted && e == nil && (!s.Mode().IsRegular() && !s.IsDir()) {
		return nil, errors.New("special files and symlinks forbidden")
	}
	flags := os.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	if write {
		flags = os.O_WRONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	}
	if create && os.IsNotExist(e) {
		flags |= os.O_CREATE | os.O_EXCL
	}
	var f *os.File
	if r.unrestricted {
		flags &^= syscall.O_NOFOLLOW
		f, e = os.OpenFile(filepath.Join(r.path, p), flags, 0600)
	} else {
		f, e = r.root.OpenFile(p, flags, 0600)
	}
	if e != nil {
		return nil, e
	}
	s, e = f.Stat()
	if e != nil || (!s.Mode().IsRegular() && !s.IsDir()) {
		f.Close()
		return nil, errors.New("special files forbidden")
	}
	if !r.unrestricted {
		root, e := r.root.Stat(".")
		if e != nil || s.Sys().(*syscall.Stat_t).Dev != root.Sys().(*syscall.Stat_t).Dev {
			f.Close()
			return nil, errors.New("nested mount crossings forbidden")
		}
	}
	return f, nil
}
func links(s os.FileInfo) uint64 { return uint64(s.Sys().(*syscall.Stat_t).Nlink) }
