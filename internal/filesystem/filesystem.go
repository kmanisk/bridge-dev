package filesystem

import (
	"context"
	"errors"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const MaxRead = 1 << 20
const MaxResults = 200
const MaxVisited = 10000

type Entry struct {
	Name      string `json:"name"`
	Directory bool   `json:"directory"`
	Symlink   bool   `json:"symlink"`
}

func List(j *fsjail.Jail, p string) ([]Entry, error) {
	f, e := j.Directory(p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	es, e := f.ReadDir(MaxResults)
	if e != nil && !errors.Is(e, io.EOF) {
		return nil, e
	}
	out := []Entry{}
	for _, s := range es {
		out = append(out, Entry{s.Name(), s.IsDir(), s.Type()&os.ModeSymlink != 0})
	}
	return out, nil
}

// Search searches file names, never follows symlinks, and bounds traversal.
func Search(ctx context.Context, j *fsjail.Jail, p, query string) ([]string, error) {
	if len(query) > 256 {
		return nil, errors.New("search query limit exceeded")
	}
	out := []string{}
	visited := 0
	var walk func(string, int) error
	walk = func(p string, depth int) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if depth > 32 || visited >= MaxVisited || len(out) >= MaxResults {
			return nil
		}
		f, e := j.Directory(p)
		if e != nil {
			return e
		}
		defer f.Close()
		for {
			es, e := f.ReadDir(128)
			if e != nil && !errors.Is(e, io.EOF) {
				return e
			}
			for _, s := range es {
				visited++
				if visited > MaxVisited || len(out) >= MaxResults {
					return nil
				}
				q := filepath.Join(p, s.Name())
				if strings.Contains(strings.ToLower(s.Name()), strings.ToLower(query)) {
					out = append(out, q)
				}
				if s.IsDir() {
					if e := walk(q, depth+1); e != nil {
						return e
					}
				}
			}
			if errors.Is(e, io.EOF) {
				break
			}
		}
		return nil
	}
	e := walk(p, 0)
	return out, e
}
