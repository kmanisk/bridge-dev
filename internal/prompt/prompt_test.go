package prompt

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type scripted struct {
	active atomic.Int64
	peak   atomic.Int64
}

func (s *scripted) Available() bool { return true }
func (s *scripted) Ask(ctx context.Context, _ string) (string, error) {
	a := s.active.Add(1)
	defer s.active.Add(-1)
	for {
		p := s.peak.Load()
		if a <= p || s.peak.CompareAndSwap(p, a) {
			break
		}
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-time.After(time.Millisecond):
		return "y", nil
	}
}
func (s *scripted) Run(ctx context.Context, _ []string) error { _, e := s.Ask(ctx, ""); return e }
func TestSerializationAndTimeout(t *testing.T) {
	s := &scripted{}
	c := New(s)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !c.Confirm(context.Background(), "test") {
				t.Error("denied")
			}
		}()
	}
	wg.Wait()
	if s.peak.Load() != 1 {
		t.Fatal(s.peak.Load())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := c.Ask(ctx, ""); e == nil {
		t.Fatal("cancel ignored")
	}
	if New(nil).Confirm(context.Background(), "no tty") {
		t.Fatal("headless approved")
	}
	if Safe("a\x1b\nb") != "ab" {
		t.Fatal("unsafe output")
	}
}

type heldPrompt struct{ entered, release chan struct{} }

func (p *heldPrompt) Available() bool { return true }
func (p *heldPrompt) Ask(ctx context.Context, _ string) (string, error) {
	close(p.entered)
	select {
	case <-p.release:
		return "y", nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
func (p *heldPrompt) Run(ctx context.Context, _ []string) error { _, e := p.Ask(ctx, ""); return e }
func TestEventsWaitForPromptAndStayBounded(t *testing.T) {
	p := &heldPrompt{make(chan struct{}), make(chan struct{})}
	c := New(p)
	var out bytes.Buffer
	w := c.Output(&out)
	done := make(chan struct{})
	go func() { defer close(done); _, _ = c.Ask(context.Background(), "Approve?") }()
	<-p.entered
	_, _ = io.WriteString(w, "task completed\n")
	_, _ = io.WriteString(w, strings.Repeat("x", 64<<10))
	if out.Len() != 0 {
		t.Fatal("event interrupted prompt")
	}
	close(p.release)
	<-done
	if !strings.Contains(out.String(), "task completed") || !strings.Contains(out.String(), "buffer full") || out.Len() > 1024 {
		t.Fatal("incorrect bounded flush")
	}
	_, _ = io.WriteString(w, "ready")
	if !strings.HasSuffix(out.String(), "ready") {
		t.Fatal("output remained blocked")
	}
}
func TestCancelledPromptFlushesEvents(t *testing.T) {
	p := &heldPrompt{make(chan struct{}), make(chan struct{})}
	c := New(p)
	var out bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _, _ = c.Ask(ctx, "Approve?") }()
	<-p.entered
	_, _ = io.WriteString(c.Output(&out), "expired\n")
	cancel()
	<-done
	if !strings.Contains(out.String(), "expired") {
		t.Fatal("output lost after timeout")
	}
}
