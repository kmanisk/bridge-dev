//go:build linux

package platform

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

func ProcessIdentity(pid int) (string, error) {
	b, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if e != nil {
		return "", e
	}
	i := strings.LastIndex(string(b), ")")
	if i < 0 {
		return "", fmt.Errorf("invalid proc stat")
	}
	fields := strings.Fields(string(b)[i+1:])
	if len(fields) < 20 {
		return "", fmt.Errorf("invalid proc stat")
	}
	boot, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if e != nil {
		return "", e
	}
	return strings.TrimSpace(string(boot)) + ":" + strconv.Itoa(pid) + ":" + fields[19], nil
}
