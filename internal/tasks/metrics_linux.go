//go:build linux

package tasks

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func liveMetrics(t *Task) {
	if t.Backend != "systemd" && t.Backend != "systemd-system" || t.Unit == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	scope := "--user"
	if t.Backend == "systemd-system" {
		scope = "--system"
	}
	b, e := exec.CommandContext(ctx, "systemctl", scope, "show", t.Unit, "-p", "MainPID", "-p", "CPUUsageNSec", "-p", "MemoryCurrent").Output()
	if e != nil {
		return
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if ok {
			values[k] = v
		}
	}
	pid, _ := strconv.Atoi(values["MainPID"])
	if pid != t.PID {
		return
	}
	if n, e := strconv.ParseInt(values["CPUUsageNSec"], 10, 64); e == nil {
		t.CPUSeconds = float64(n) / 1e9
	}
	if n, e := strconv.ParseInt(values["MemoryCurrent"], 10, 64); e == nil && n >= 0 {
		t.MemoryBytes = n
	}
}
