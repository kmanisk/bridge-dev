// Package fsjail enforces filesystem authority using pinned directory handles.
package fsjail

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type entry struct {
	unrestricted bool
	path         string
	root         *os.Root
}
type Jail struct {
	roots []entry
	mu    sync.Mutex
}

func New(paths []string) (*Jail, error) {
	j := &Jail{}
	for _, p := range paths {
		a, e := filepath.Abs(p)
		if e != nil {
			j.Close()
			return nil, e
		}
		a, e = filepath.EvalSymlinks(a)
		if e != nil {
			j.Close()
			return nil, e
		}
		r, e := os.OpenRoot(a)
		if e != nil {
			j.Close()
			return nil, e
		}
		j.roots = append(j.roots, entry{path: a, root: r})
	}
	if len(j.roots) == 0 {
		return nil, errors.New("no roots")
	}
	return j, nil
}
func (j *Jail) Close() {
	for _, r := range j.roots {
		_ = r.root.Close()
	}
}
func (j *Jail) resolve(p string) (entry, string, error) {
	if strings.ContainsRune(p, 0) || p == "" {
		return entry{}, "", errors.New("invalid path")
	}
	for _, r := range j.roots {
		q := p
		if filepath.IsAbs(q) {
			var e error
			q, e = filepath.Rel(r.path, q)
			if e != nil {
				continue
			}
		}
		if !filepath.IsLocal(q) {
			continue
		}
		return r, q, nil
	}
	return entry{}, "", errors.New("path outside allowed roots")
}
func (j *Jail) Open(p string, write bool, create bool) (*os.File, error) {
	r, q, e := j.resolve(p)
	if e != nil {
		return nil, e
	}
	return secureOpen(r, q, write, create)
}
func (j *Jail) Directory(p string) (*os.File, error) {
	f, e := j.Open(p, false, false)
	if e != nil {
		return nil, e
	}
	s, e := f.Stat()
	if e != nil || !s.IsDir() {
		f.Close()
		return nil, errors.New("working path is not a directory")
	}
	return f, nil
}
func (j *Jail) Read(p string, limit int64) ([]byte, error) {
	f, e := j.Open(p, false, false)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	s, e := f.Stat()
	if e != nil || !s.Mode().IsRegular() {
		return nil, errors.New("regular file required")
	}
	if s.Size() > limit {
		return nil, fmt.Errorf("file exceeds %d byte limit", limit)
	}
	b, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > limit {
		return nil, errors.New("read limit exceeded")
	}
	return b, nil
}

// Write validates the opened inode before truncation, preventing escaped paths
// and hard-link writes. Concurrent edits are serialized within this server.
func (j *Jail) Write(p string, b []byte) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.write(p, b)
}
func (j *Jail) write(p string, b []byte) error {
	if len(b) > 1<<20 {
		return errors.New("write limit exceeded")
	}
	mode := os.FileMode(0600)
	f, e := j.Open(p, true, false)
	if e == nil {
		s, se := f.Stat()
		f.Close()
		if se != nil || !s.Mode().IsRegular() {
			return errors.New("regular file required")
		}
		if links(s) > 1 {
			return errors.New("hard-linked writes are forbidden")
		}
		mode = s.Mode()
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	r, q, e := j.resolve(p)
	if e != nil {
		return e
	}
	parent, e := secureOpen(r, filepath.Dir(q), false, false)
	if e != nil {
		return e
	}
	defer parent.Close()
	st, e := parent.Stat()
	if e != nil || !st.IsDir() {
		return errors.New("parent must be a directory")
	}
	return replace(parent, filepath.Base(q), b, mode)
}
func (j *Jail) Edit(p, old, new string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	b, e := j.Read(p, 1<<20)
	if e != nil {
		return e
	}
	if old == "" || strings.Count(string(b), old) != 1 {
		return errors.New("old text must match exactly once")
	}
	return j.write(p, []byte(strings.Replace(string(b), old, new, 1)))
}

// Unrestricted retains regular-file checks but permits all paths and mounts.
func (j *Jail) Unrestricted() {
	for i := range j.roots {
		j.roots[i].unrestricted = true
	}
}

// Path describes the lexical target under a pinned root. Actual access still
// uses descriptor-relative validation, including symlink and mount checks.
func (j *Jail) Path(p string) (string, error) {
	r, q, e := j.resolve(p)
	if e != nil {
		return "", e
	}
	return filepath.Join(r.path, q), nil
}

// Deny constructs an empty authority used when a privileged grant expires without safe roots.
func Deny() *Jail { return &Jail{} }
