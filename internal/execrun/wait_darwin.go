//go:build darwin

package execrun

import (
	"errors"
	"golang.org/x/sys/unix"
)

func waitUnreaped(pid int) error {
	k, e := unix.Kqueue()
	if e != nil {
		return e
	}
	defer unix.Close(k)
	changes := []unix.Kevent_t{{Ident: uint64(pid), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT}}
	events := make([]unix.Kevent_t, 1)
	for {
		_, e = unix.Kevent(k, changes, events, nil)
		if !errors.Is(e, unix.EINTR) {
			return e
		}
		changes = nil
	}
}
