package connect

import (
	"context"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

func CopyURL(ctx context.Context, url string) bool {
	candidates := [][]string{{"wl-copy"}, {"xclip", "-selection", "clipboard"}, {"xsel", "--clipboard", "--input"}}
	if runtime.GOOS == "darwin" {
		candidates = append([][]string{{"pbcopy"}}, candidates...)
	}
	for _, a := range candidates {
		p, e := exec.LookPath(a[0])
		if e != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		c := exec.CommandContext(ctx, p, a[1:]...)
		c.Stdin = strings.NewReader(url)
		c.Stdout = io.Discard
		c.Stderr = io.Discard
		e = c.Run()
		cancel()
		if e == nil {
			return true
		}
	}
	return false
}
func Instructions(w io.Writer, url string) {
	_, _ = io.WriteString(w, "Web apps cannot be registered automatically.\nClaude web: Settings / Connectors / Add custom connector (or Customize / Connectors).\n  Use "+url+"; select OAuth and Register automatically, then authorize.\nChatGPT web: Plugins / + / Add custom MCP server (current documentation).\n  Older/account-specific UI: Settings / Apps / Advanced settings / Developer mode / Create app.\n  Use "+url+" and complete OAuth; select DCR/automatic registration rather than CIMD. Account/workspace support and labels vary.\nOAuth success does not prove write-tool availability.\n")
}
