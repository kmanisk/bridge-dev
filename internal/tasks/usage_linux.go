//go:build linux

package tasks

import (
	"os"
	"syscall"
)

func peakMemory(s *os.ProcessState) int64 {
	if r, ok := s.SysUsage().(*syscall.Rusage); ok {
		return r.Maxrss * 1024
	}
	return 0
}
