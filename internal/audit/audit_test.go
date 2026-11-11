package audit

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestMetadataOnlyAndRotation(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	l, e := New(dir)
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := l.Write(Record{Client: "test", Operation: "exec", Mode: "user", Allowed: true}); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	p := filepath.Join(dir, "audit.jsonl")
	b, e := os.ReadFile(p)
	if e != nil {
		t.Fatal(e)
	}
	lines := bytes.Split(bytes.TrimSpace(b), []byte("\n"))
	if len(lines) != 10 {
		t.Fatal(len(lines))
	}
	for _, line := range lines {
		var v map[string]any
		if json.Unmarshal(line, &v) != nil {
			t.Fatal(string(line))
		}
		for _, k := range []string{"argv", "content", "password", "token", "environment", "authorization"} {
			if _, ok := v[k]; ok {
				t.Fatal(k)
			}
		}
	}
	if e = os.WriteFile(p, []byte(strings.Repeat("x", MaxBytes)), 0600); e != nil {
		t.Fatal(e)
	}
	if e = l.Write(Record{Operation: "rotated"}); e != nil {
		t.Fatal(e)
	}
	if s, e := os.Stat(p + ".1"); e != nil || s.Size() != MaxBytes {
		t.Fatal(e)
	}
}
