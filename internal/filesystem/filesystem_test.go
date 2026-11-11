package filesystem

import (
	"context"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"os"
	"path/filepath"
	"testing"
)

func TestSlicesAndPages(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "large"), []byte("0123456789"), 0600)
	os.WriteFile(filepath.Join(dir, "other"), []byte("a needle b"), 0600)
	j, e := fsjail.New([]string{dir})
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	r, e := ReadSlice(j, "large", 4, 3, 3)
	if e != nil || r.Content != "456" || r.Next != 7 || r.EOF {
		t.Fatal(r, e)
	}
	if _, e = ReadSlice(j, "large", 0, 4, 3); e == nil {
		t.Fatal("bound ignored")
	}
	page, e := ListPage(j, ".", 0, 1, 2)
	if e != nil || !page.More || len(page.Entries) != 1 {
		t.Fatal(page, e)
	}
	next, e := ListPage(j, ".", page.Next, 1, 2)
	if e != nil || next.More || len(next.Entries) != 1 || next.Entries[0].Name == page.Entries[0].Name {
		t.Fatal(next, e)
	}
	matches, e := SearchPage(context.Background(), j, ".", "needle", SearchOptions{Limit: 2, Results: 2, Visited: 100, Depth: 32, ReadBytes: 100, Content: true})
	if e != nil || len(matches.Entries) != 1 || matches.Entries[0] != "other" {
		t.Fatal(matches, e)
	}
	matches, e = SearchPage(context.Background(), j, ".", "", SearchOptions{Limit: 1, Results: 2, Visited: 100, Depth: 32})
	if e != nil || !matches.More {
		t.Fatal(matches, e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e = SearchPage(ctx, j, ".", "", SearchOptions{}); e == nil {
		t.Fatal("cancel ignored")
	}
	os.Symlink(filepath.Join(t.TempDir(), "escape"), filepath.Join(dir, "link"))
	if _, e = ReadSlice(j, "link", 0, 2, 2); e == nil {
		t.Fatal("symlink escape")
	}
	if _, e = ReadSlice(j, "../escape", 0, 2, 2); e == nil {
		t.Fatal("traversal")
	}
}
