//go:build darwin

package platform

import (
	"fmt"
	"os/exec"
	"strings"
)

func ProcessIdentity(pid int) (string, error) {
	b, e := exec.Command("/bin/ps", "-p", fmt.Sprint(pid), "-o", "lstart=").Output()
	if e != nil {
		return "", e
	}
	return fmt.Sprint(pid) + ":" + strings.TrimSpace(string(b)), nil
}
