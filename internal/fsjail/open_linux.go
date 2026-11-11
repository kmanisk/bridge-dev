//go:build linux

package fsjail

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"syscall"
)

func secureOpen(r entry, p string, write, create bool) (*os.File, error) {
	// OpenRoot pins authority; Openat2 additionally rejects symlinks, magic
	// links, and nested mounts. No EvalSymlinks authorization check is used.
	d, e := r.root.Open(".")
	if e != nil {
		return nil, e
	}
	defer d.Close()
	how := &unix.OpenHow{Flags: unix.O_PATH | unix.O_CLOEXEC, Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV}
	if r.unrestricted {
		how.Resolve = unix.RESOLVE_IN_ROOT | unix.RESOLVE_NO_MAGICLINKS
	}
	fd, e := unix.Openat2(int(d.Fd()), p, how)
	if errors.Is(e, unix.ENOENT) && create {
		how.Flags = unix.O_WRONLY | unix.O_CREAT | unix.O_EXCL | unix.O_CLOEXEC | unix.O_NONBLOCK
		how.Mode = 0600
		fd, e = unix.Openat2(int(d.Fd()), p, how)
		if e != nil {
			return nil, e
		}
		return os.NewFile(uintptr(fd), p), nil
	}
	if e != nil {
		return nil, fmt.Errorf("secure open (Linux openat2 required): %w", e)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if e = unix.Fstat(fd, &st); e != nil {
		return nil, e
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG && st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return nil, errors.New("special files forbidden")
	}
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NONBLOCK
	if write {
		if st.Mode&unix.S_IFMT != unix.S_IFREG {
			return nil, errors.New("regular file required")
		}
		flags = unix.O_WRONLY | unix.O_CLOEXEC | unix.O_NONBLOCK
	}
	// Reopen a validated, pinned inode, not the untrusted pathname. The proc
	// mount is required. The O_PATH descriptor remains live until reopen.
	data, e := unix.Open(fmt.Sprintf("/proc/self/fd/%d", fd), flags, 0)
	if e != nil {
		return nil, e
	}
	return os.NewFile(uintptr(data), p), nil
}
func links(s os.FileInfo) uint64 { return uint64(s.Sys().(*syscall.Stat_t).Nlink) }
