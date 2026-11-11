// Package audit records metadata only. Arguments, paths, contents, headers and
// environment are deliberately absent from the record schema.
package audit

import (
	"encoding/json"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"os"
	"path/filepath"
	"time"
)

const MaxBytes = 4 << 20
const Retained = 3

type Record struct {
	Phase      string    `json:"phase,omitempty"`
	Time       time.Time `json:"timestamp"`
	Client     string    `json:"client"`
	Operation  string    `json:"operation"`
	Mode       string    `json:"mode"`
	Allowed    bool      `json:"allowed"`
	DurationMS int64     `json:"duration_ms"`
	ExitCode   *int      `json:"exit_code,omitempty"`
	TaskID     string    `json:"task_id,omitempty"`
	Sudo       bool      `json:"sudo"`
}
type Log struct{ dir string }

func New(dir string) (*Log, error) {
	if e := platform.PrivateDir(dir); e != nil {
		return nil, e
	}
	return &Log{dir}, nil
}
func (l *Log) Write(r Record) error {
	unlock, e := platform.Lock(filepath.Join(l.dir, "audit.lock"))
	if e != nil {
		return e
	}
	defer unlock()
	p := filepath.Join(l.dir, "audit.jsonl")
	if s, e := os.Stat(p); e == nil && s.Size() >= MaxBytes {
		_ = os.Remove(p + ".3")
		for i := 2; i >= 1; i-- {
			old := p + "." + string(rune('0'+i))
			next := p + "." + string(rune('1'+i))
			if e = os.Rename(old, next); e != nil && !os.IsNotExist(e) {
				return e
			}
		}
		if e = os.Rename(p, p+".1"); e != nil {
			return e
		}
	}
	f, e := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	r.Time = time.Now().UTC()
	if e = json.NewEncoder(f).Encode(r); e != nil {
		return e
	}
	return f.Sync()
}
