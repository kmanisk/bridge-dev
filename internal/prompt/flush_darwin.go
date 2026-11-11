//go:build darwin

package prompt

import "golang.org/x/sys/unix"

func flushInput(fd int) {
	if t, e := unix.IoctlGetTermios(fd, unix.TIOCGETA); e == nil {
		_ = unix.IoctlSetTermios(fd, unix.TIOCSETAF, t)
	}
}
