package filesystem

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/kmanisk/bridge-dev/internal/fsjail"
)

type Slice struct {
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	Next     int64  `json:"next_offset"`
	EOF      bool   `json:"eof"`
	Size     int64  `json:"size"`
}

func ReadSlice(j *fsjail.Jail, path string, offset, limit, maxBytes int64) (Slice, error) {
	if offset < 0 || limit < 0 {
		return Slice{}, errors.New("negative read offset/limit")
	}
	if limit == 0 {
		limit = maxBytes
	}
	if maxBytes > 0 && limit > maxBytes {
		return Slice{}, errors.New("read slice exceeds configured bound")
	}
	f, e := j.Open(path, false, false)
	if e != nil {
		return Slice{}, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() {
		return Slice{}, errors.New("regular file required")
	}
	if _, e = f.Seek(offset, io.SeekStart); e != nil {
		return Slice{}, e
	}
	var r io.Reader = f
	if limit > 0 {
		r = io.LimitReader(f, limit)
	}
	b, e := io.ReadAll(r)
	if e != nil {
		return Slice{}, e
	}
	out := Slice{Content: string(b), Encoding: "utf8", Next: offset + int64(len(b)), Size: st.Size()}
	out.EOF = out.Next >= out.Size
	if !utf8.Valid(b) {
		out.Content = base64.StdEncoding.EncodeToString(b)
		out.Encoding = "base64"
	}
	return out, nil
}

type Page[T any] struct {
	Entries    []T   `json:"entries"`
	Next       int64 `json:"next_offset"`
	More       bool  `json:"more"`
	Incomplete bool  `json:"incomplete,omitempty"`
	Skipped    int   `json:"skipped,omitempty"`
}

func ListPage(j *fsjail.Jail, path string, offset int64, limit, maxResults int) (Page[Entry], error) {
	out := Page[Entry]{Entries: []Entry{}}
	if offset < 0 || limit < 0 {
		return out, errors.New("negative listing cursor/limit")
	}
	if limit == 0 {
		limit = maxResults
	}
	if maxResults > 0 && limit > maxResults {
		return out, errors.New("listing limit exceeds configured bound")
	}
	f, e := j.Directory(path)
	if e != nil {
		return out, e
	}
	defer f.Close()
	for n := int64(0); n < offset; {
		es, e := f.ReadDir(int(min(128, offset-n)))
		n += int64(len(es))
		if e == io.EOF {
			return out, nil
		}
		if e != nil {
			return out, e
		}
	}
	count := limit
	if count > 0 {
		count++
	}
	es, e := f.ReadDir(count)
	if e != nil && e != io.EOF {
		return out, e
	}
	if limit > 0 && len(es) > limit {
		out.More = true
		es = es[:limit]
	}
	for _, s := range es {
		out.Entries = append(out.Entries, Entry{s.Name(), s.IsDir(), s.Type()&os.ModeSymlink != 0})
	}
	out.Next = offset + int64(len(es))
	return out, nil
}

type SearchOptions struct {
	Offset                         int64
	Limit, Results, Visited, Depth int
	ReadBytes                      int64
	Content                        bool
}

// SearchPage resumes a bounded name/content scan. Directory changes may change
// ordering; cursors are offsets, not snapshots. Every access is jailed again.
func SearchPage(ctx context.Context, j *fsjail.Jail, path, query string, opt SearchOptions) (Page[string], error) {
	out := Page[string]{Entries: []string{}}
	if len(query) > 256 || opt.Offset < 0 || opt.Limit < 0 {
		return out, errors.New("invalid search query/cursor/limit")
	}
	if opt.Limit == 0 {
		opt.Limit = opt.Results
	}
	if opt.Results > 0 && opt.Limit > opt.Results {
		return out, errors.New("search limit exceeds configured bound")
	}
	visited := 0
	matched := int64(0)
	stop := false
	query = strings.ToLower(query)
	var walk func(string, int) error
	walk = func(path string, depth int) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if stop {
			return nil
		}
		if opt.Depth > 0 && depth > opt.Depth {
			out.Incomplete = true
			return nil
		}
		f, e := j.Directory(path)
		if e != nil {
			if depth == 0 {
				return e
			}
			out.Skipped++
			return nil
		}
		defer f.Close()
		for {
			es, e := f.ReadDir(128)
			if e != nil && e != io.EOF {
				return e
			}
			for _, s := range es {
				visited++
				if opt.Visited > 0 && visited > opt.Visited {
					out.Incomplete = true
					stop = true
					return nil
				}
				p := filepath.Join(path, s.Name())
				match := false
				if !opt.Content {
					match = strings.Contains(strings.ToLower(s.Name()), query)
				} else if s.Type().IsRegular() {
					slice, e := ReadSlice(j, p, 0, opt.ReadBytes, opt.ReadBytes)
					if e != nil {
						out.Skipped++
					} else if slice.Encoding == "utf8" {
						match = strings.Contains(strings.ToLower(slice.Content), query)
						if !slice.EOF {
							out.Incomplete = true
						}
					}
				}
				if match {
					matched++
					if matched > opt.Offset {
						if opt.Limit > 0 && len(out.Entries) >= opt.Limit {
							out.More = true
							stop = true
							return nil
						}
						out.Entries = append(out.Entries, p)
					}
				}
				if s.IsDir() {
					if e := walk(p, depth+1); e != nil {
						return e
					}
					if stop {
						return nil
					}
				}
			}
			if e == io.EOF {
				return nil
			}
		}
	}
	e := walk(path, 0)
	out.Next = opt.Offset + int64(len(out.Entries))
	return out, e
}
