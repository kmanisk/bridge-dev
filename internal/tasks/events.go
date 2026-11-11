package tasks

import (
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Event struct {
	Cursor    string    `json:"cursor"`
	ID        string    `json:"id"`
	State     string    `json:"state"`
	ExitCode  *int      `json:"exit_code,omitempty"`
	Completed time.Time `json:"completed"`
	Signal    string    `json:"signal,omitempty"`
}

// recordCompletion allocates a monotonic sequence under a cross-process lock.
// The event is independent of task metadata, so forget does not erase it.
func (m *Manager) recordCompletion(t *Task) error {
	dir := filepath.Join(m.Dir, "events")
	if e := platform.PrivateDir(dir); e != nil {
		return e
	}
	unlock, e := platform.Lock(filepath.Join(m.Dir, "events.lock"))
	if e != nil {
		return e
	}
	defer unlock()
	p := filepath.Join(dir, t.ID+".json")
	var existing Event
	if e = platform.ReadJSON(p, &existing); e == nil {
		return nil
	} else if !os.IsNotExist(e) {
		return e
	}
	var seq uint64
	pseq := filepath.Join(m.Dir, "event-sequence.json")
	if e = platform.ReadJSON(pseq, &seq); e != nil && !os.IsNotExist(e) {
		return e
	}
	seq++
	if e = platform.AtomicJSON(pseq, seq); e != nil {
		return e
	}
	event := Event{Cursor: fmt.Sprintf("%020d", seq), ID: t.ID, State: t.State, ExitCode: t.ExitCode, Completed: *t.Completed, Signal: t.Signal}
	return platform.AtomicJSON(p, event)
}
func (m *Manager) Events(after string) ([]Event, error) {
	dir := filepath.Join(m.Dir, "events")
	es, e := os.ReadDir(dir)
	if os.IsNotExist(e) {
		return []Event{}, nil
	}
	if e != nil {
		return nil, e
	}
	out := []Event{}
	for _, d := range es {
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".json") || len(d.Name()) != 37 {
			continue
		}
		var event Event
		if e = platform.ReadJSON(filepath.Join(dir, d.Name()), &event); e != nil {
			return nil, e
		}
		if event.Cursor > after {
			out = append(out, event)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Cursor < out[j].Cursor })
	if len(out) > 20 {
		out = out[:20]
	}
	return out, nil
}
func (m *Manager) recoverCompletion(t *Task) error {
	var event Event
	e := platform.ReadJSON(filepath.Join(m.Dir, "events", t.ID+".json"), &event)
	if e != nil {
		return e
	}
	if event.ID != t.ID {
		return errors.New("event identity mismatch")
	}
	t.State = event.State
	t.ExitCode = event.ExitCode
	t.Completed = &event.Completed
	t.Signal = event.Signal
	return nil
}
