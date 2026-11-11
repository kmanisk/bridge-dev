package platform

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"time"
)

func Processes(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, "/bin/ps", "-eo", "pid,ppid,comm")
	out := &processOutput{}
	c.Stdout = out
	e := c.Run()
	return strings.TrimSpace(out.b.String()), e
}

type processOutput struct{ b bytes.Buffer }

func (w *processOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := (64 << 10) - w.b.Len()
	if len(p) > remaining {
		p = p[:max(0, remaining)]
	}
	_, _ = w.b.Write(p)
	return n, nil
}
