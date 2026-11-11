package policy

import (
	"strings"
	"testing"
)

func TestPolicy(t *testing.T) {
	for _, m := range []Mode{"", "invalid"} {
		if m.Validate(true) == nil {
			t.Fatal(m)
		}
	}
	p := Commands{Allow: []string{"/bin/echo"}, Deny: []string{"/bin/echo"}}
	if p.Check([]string{"/bin/echo"}, false, false) == nil {
		t.Fatal("deny precedence")
	}
	if p.Check([]string{"/bin/id"}, true, true) != nil {
		t.Fatal("dangerous must bypass command policy")
	}
}
func TestSudoersPreview(t *testing.T) {
	v, e := SudoersPreview("testuser", []string{"/usr/bin/id"})
	if e != nil || !strings.Contains(v, `/usr/bin/id ""`) {
		t.Fatal(v, e)
	}
	for _, u := range []string{"root\nALL", "bad,user"} {
		if _, e = SudoersPreview(u, []string{"/usr/bin/id"}); e == nil {
			t.Fatal(u)
		}
	}
	if _, e = SudoersPreview("testuser", []string{"/bin/echo ALL"}); e == nil {
		t.Fatal("injection")
	}
}
