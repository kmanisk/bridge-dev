package tunnel

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestOwnedFakeTunnel(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cloudflared")
	os.WriteFile(p, []byte("#!/bin/sh\necho 'https://safe-test-name.trycloudflare.com' >&2\necho 'INF Registered tunnel connection connIndex=0 location=test' >&2\nexec sleep 30\n"), 0700)
	tt, e := Start(context.Background(), p, "http://127.0.0.1:1234")
	if e != nil {
		t.Fatal(e)
	}
	if tt.URL != "https://safe-test-name.trycloudflare.com" {
		t.Fatal(tt.URL)
	}
	// Wait a tiny bit for log capture
	time.Sleep(50 * time.Millisecond)
	if tt.State() != "registered" && tt.State() != "url announced" && tt.State() != "running" {
		t.Fatalf("unexpected state: %s", tt.State())
	}
	logs := tt.RecentLogs()
	if len(logs) == 0 {
		t.Fatal("expected captured logs")
	}
	tt.Close()
	tt.Close()
	if !tt.IsDone() {
		t.Fatal("tunnel not marked done after close")
	}
	if ParseURL("https://evil.trycloudflare.com.evil.example") != "" {
		t.Fatal("hostname suffix accepted")
	}
}

// Requirement L: Tunnel process exits before readiness
func TestTunnelProcessExitsBeforeReadiness(t *testing.T) {
	// Exits immediately before announcing URL
	dir := t.TempDir()
	p := filepath.Join(dir, "cloudflared")
	os.WriteFile(p, []byte("#!/bin/sh\necho 'fatal cloudflared error' >&2\nexit 42\n"), 0700)

	_, err := Start(context.Background(), p, "http://127.0.0.1:1234")
	if err == nil {
		t.Fatal("expected error when cloudflared exits immediately, got nil")
	}
	if !strings.Contains(err.Error(), "exited") && !strings.Contains(err.Error(), "42") {
		t.Fatalf("expected exit status in error message, got: %v", err)
	}

	// Exits right after announcing URL
	p2 := filepath.Join(dir, "cloudflared2")
	os.WriteFile(p2, []byte("#!/bin/sh\necho 'https://exit-quick.trycloudflare.com' >&2\nexit 17\n"), 0700)

	tt, err := Start(context.Background(), p2, "http://127.0.0.1:1234")
	if err != nil {
		t.Fatalf("unexpected Start error: %v", err)
	}
	// Wait for process to exit
	select {
	case <-tt.Done():
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for tunnel to exit")
	}
	if !tt.IsDone() {
		t.Fatal("expected IsDone to be true")
	}
	state := tt.State()
	if !strings.Contains(state, "exited") || !strings.Contains(state, "17") {
		t.Fatalf("expected exit status in state, got: %s", state)
	}
	tt.Close()
}

// Requirement M: Timeout cleanup closes only owned processes
func TestTimeoutCleanupClosesOnlyOwnedProcess(t *testing.T) {
	dir := t.TempDir()
	// Start an independent unrelated process that should NOT be killed
	unrelatedCmd := exec.Command("sleep", "30")
	if err := unrelatedCmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = unrelatedCmd.Process.Kill()
		_ = unrelatedCmd.Wait()
	}()

	// Start owned fake tunnel
	p := filepath.Join(dir, "cloudflared")
	os.WriteFile(p, []byte("#!/bin/sh\necho 'https://owned-fixture.trycloudflare.com' >&2\nexec sleep 30\n"), 0700)

	tt, err := Start(context.Background(), p, "http://127.0.0.1:1234")
	if err != nil {
		t.Fatal(err)
	}

	// Close owned tunnel
	tt.Close()

	// Verify owned tunnel is done
	if !tt.IsDone() {
		t.Fatal("owned tunnel not stopped")
	}

	// Verify unrelated process is still running (kill with signal 0)
	if err := syscall.Kill(unrelatedCmd.Process.Pid, 0); err != nil {
		t.Fatalf("unrelated process was unexpectedly terminated: %v", err)
	}
}

func TestTunnelWaitRegistered(t *testing.T) {
	dir := t.TempDir()

	// 1. Success case: Registered tunnel connection emitted
	p1 := filepath.Join(dir, "cf-registered")
	os.WriteFile(p1, []byte("#!/bin/sh\necho 'https://wait-reg.trycloudflare.com' >&2\necho 'INF Registered tunnel connection connIndex=0' >&2\nexec sleep 30\n"), 0700)
	tt1, err := Start(context.Background(), p1, "http://127.0.0.1:1234")
	if err != nil {
		t.Fatal(err)
	}
	defer tt1.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !tt1.WaitRegistered(ctx, time.Second) {
		t.Fatal("expected WaitRegistered to return true on registered connection")
	}

	// 2. Process exits without registering
	p2 := filepath.Join(dir, "cf-exit")
	os.WriteFile(p2, []byte("#!/bin/sh\necho 'https://exit-reg.trycloudflare.com' >&2\nexit 1\n"), 0700)
	tt2, err := Start(context.Background(), p2, "http://127.0.0.1:1234")
	if err != nil {
		t.Fatal(err)
	}
	defer tt2.Close()
	if tt2.WaitRegistered(context.Background(), 2*time.Second) {
		t.Fatal("expected WaitRegistered to return false when tunnel process exits")
	}

	// 3. Timeout without registering
	p3 := filepath.Join(dir, "cf-timeout")
	os.WriteFile(p3, []byte("#!/bin/sh\necho 'https://slow-reg.trycloudflare.com' >&2\nexec sleep 30\n"), 0700)
	tt3, err := Start(context.Background(), p3, "http://127.0.0.1:1234")
	if err != nil {
		t.Fatal(err)
	}
	defer tt3.Close()
	if tt3.WaitRegistered(context.Background(), 25*time.Millisecond) {
		t.Fatal("expected WaitRegistered to return false on timeout")
	}
}
