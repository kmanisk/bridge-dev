package connect

import (
	"context"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/events"
	"github.com/kmanisk/bridge-dev/internal/privilege"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/transport"
	"io"
)

func Run(ctx context.Context, args []string, getenv func(string) string, p *prompt.Coordinator, out io.Writer, opt transport.Options) error {
	out = p.Output(&events.Writer{Out: out})
	preliminary, e := config.LoadConnect(args, getenv)
	if e != nil {
		return e
	}
	if running, e := transport.Status(preliminary); e == nil && running.State != "stopped" {
		fmt.Fprintf(out, "Existing Bridge instance: %s, mode=%s, URL=%s. Use status; use down only if you intend to replace it.\n", running.State, running.Mode, running.PublicURL)
		return errors.New("an instance already owns this state directory; existing session preserved")
	}
	c, e := Prepare(ctx, args, getenv, p, out)
	if e != nil {
		return e
	}
	if e = privilege.Authorize(ctx, &c, p, out, true); e != nil {
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
