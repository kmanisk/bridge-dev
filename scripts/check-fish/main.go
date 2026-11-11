// Command check-fish syntax-checks documentation without executing its examples.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
)

func main() {
	b, e := os.ReadFile("MANUAL_TEST.md")
	if e != nil {
		panic(e)
	}
	blocks := regexp.MustCompile("(?s)```fish\\n(.*?)```").FindAllSubmatch(b, -1)
	if len(blocks) == 0 {
		panic("Fish examples missing")
	}
	dir, e := os.MkdirTemp("", "bridge-fish-docs-")
	if e != nil {
		panic(e)
	}
	defer os.RemoveAll(dir)
	for i, block := range blocks {
		path := filepath.Join(dir, fmt.Sprintf("example-%d.fish", i))
		if e = os.WriteFile(path, block[1], 0600); e != nil {
			panic(e)
		}
		cmd := exec.Command("fish", "-n", path)
		if b, e = cmd.CombinedOutput(); e != nil {
			fmt.Fprintln(os.Stderr, string(b))
			os.Exit(1)
		}
	}
	fmt.Printf("Validated %d Fish blocks without execution\n", len(blocks))
}
