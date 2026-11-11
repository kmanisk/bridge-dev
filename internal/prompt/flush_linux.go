//go:build linux

package prompt

import "golang.org/x/sys/unix"

func flushInput(fd int) {
	if t, e := unix.IoctlGetTermios(fd, unix.TCGETS); e == nil {
		_ = unix.IoctlSetTermios(fd, unix.TCSETSF, t)
	}
}
