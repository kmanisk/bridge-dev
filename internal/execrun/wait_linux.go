//go:build linux

package execrun

import (
	"errors"
	"golang.org/x/sys/unix"
)

func waitUnreaped(pid int) error {
	var info unix.Siginfo
	for {
		e := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if !errors.Is(e, unix.EINTR) {
			return e
		}
	}
}
