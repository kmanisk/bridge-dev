package prompt

import (
	"context"
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
