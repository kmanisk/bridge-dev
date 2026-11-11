package connect

import (
	"context"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/events"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/transport"
	"io"
)

func Run(ctx context.Context, args []string, getenv func(string) string, p *prompt.Coordinator, out io.Writer, opt transport.Options) error {
	out = &events.Writer{Out: out}
	c, e := Prepare(ctx, args, getenv, p, out)
	if e != nil {
		return e
	}
	opt.Prompts = p
	opt.Connect = true
	opt.Out = out
	ready := opt.Ready
	opt.Ready = func(rt transport.Runtime) {
		if CopyURL(ctx, rt.PublicURL) {
			fmt.Fprintln(out, "MCP URL copied to clipboard.")
		} else {
			fmt.Fprintln(out, "Clipboard unavailable; use the printed MCP URL.")
		}
		if c.Tunnel == "none" {
			fmt.Fprintln(out, "Local-only endpoint: web clients need an external HTTPS tunnel.")
		} else {
			Instructions(out, rt.PublicURL)
		}
		if ready != nil {
			ready(rt)
		}
	}
	return transport.RunWithOptions(ctx, c, opt)
}
