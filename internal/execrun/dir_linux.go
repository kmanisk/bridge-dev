//go:build linux

package execrun

import (
	"fmt"
	"os"
)

func DescriptorPath(f *os.File) string { return fmt.Sprintf("/proc/self/fd/%d", f.Fd()) }
