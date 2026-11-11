//go:build darwin

package tasks

import (
	"os"
	"syscall"
)

func peakMemory(s *os.ProcessState) int64 {
	if r, ok := s.SysUsage().(*syscall.Rusage); ok {
		return r.Maxrss
	}
	return 0
}
