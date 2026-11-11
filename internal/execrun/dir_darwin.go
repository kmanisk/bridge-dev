//go:build darwin

package execrun

import (
	"fmt"
	"os"
)

func DescriptorPath(f *os.File) string { return fmt.Sprintf("/dev/fd/%d", f.Fd()) }
