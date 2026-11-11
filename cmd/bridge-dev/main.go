package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/connect"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/mcpserver"
	"github.com/kmanisk/bridge-dev/internal/privilege"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/tasks"
	"github.com/kmanisk/bridge-dev/internal/transport"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"runtime"
	"strings"
	"syscall"
)

func main() {
	if e := run(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, identity.Binary+":", e)
		os.Exit(1)
	}
}
func printJSON(v any) error { return json.NewEncoder(os.Stdout).Encode(v) }
func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: " + identity.Binary + " stdio|up|down|status|tasks|config check|doctor")
	}
	if args[0] == "_sudoers-install" {
		if len(args) != 4 || os.Geteuid() != 0 {
			return errors.New("invalid privileged installer invocation")
		}
		visudo := "/usr/bin/visudo"
		if _, e := os.Stat(visudo); e != nil {
			visudo = "/usr/sbin/visudo"
		}
		return privilege.InstallValidated(args[1], args[2], args[3], "/etc/sudoers.d", visudo)
	}
	if args[0] == "_task-worker" {
		if len(args) != 3 {
			return errors.New("invalid worker arguments")
		}
		return tasks.Worker(args[1], args[2])
	}
	if args[0] == "--version" || args[0] == "version" {
		fmt.Println(identity.Name, identity.Version)
		return nil
	}
	if args[0] == "--help" || args[0] == "help" || args[0] == "-h" {
		fmt.Println("Usage: " + identity.Binary + " stdio|up|down|status|tasks|config check|doctor|sudoers preview")
		return nil
	}
	cmd := args[0]
	args = args[1:]
	action := ""
	id := ""
	if cmd == "sudoers" {
		if len(args) == 0 || (args[0] != "preview" && args[0] != "install") {
			return errors.New("usage: sudoers preview|install --sudo-commands /absolute/command")
		}
		action = args[0]
		args = args[1:]
	}
	if cmd == "config" {
		if len(args) == 0 || args[0] != "check" {
			return errors.New("usage: config check")
		}
		args = args[1:]
	}
	if cmd == "clients" {
		if len(args) > 0 {
			action = args[0]
			args = args[1:]
		}
		if action == "revoke" {
			if len(args) == 0 {
				return errors.New("clients revoke requires ID")
			}
			id = args[0]
			args = args[1:]
		}
	}
	if cmd == "tasks" {
		if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
			action = args[0]
			args = args[1:]
			if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
				id = args[0]
				args = args[1:]
			}
		}
	}
	if cmd == "connect" {
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		tty := prompt.Open()
		defer tty.Close()
		return connect.Run(ctx, args, os.Getenv, prompt.New(tty), os.Stderr, transport.Options{})
	}
	c, e := config.Load(args, os.Getenv)
	if e != nil {
		return e
	}
	if c.Mode == "dangerous" {
		fmt.Fprintln(os.Stderr, "WARNING: dangerous mode grants unrestricted local filesystem and command access")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	switch cmd {
	case "sudoers":
		u, e := user.Current()
		if e != nil {
			return e
		}
		tty := prompt.Open()
		defer tty.Close()
		return privilege.Sudoers(ctx, u.Username, c.SudoAllow, action == "install", prompt.New(tty), os.Stdout)
	case "up":
		if c.Detach {
			unit, e := transport.Detach(ctx, c)
			if e != nil {
				return e
			}
			return printJSON(map[string]string{"transient_unit": unit})
		}
		tty := prompt.Open()
		defer tty.Close()
		p := prompt.New(tty)
		if c.Headless {
			p = prompt.New(nil)
		}
		if e = privilege.Authorize(ctx, &c, p, os.Stderr, true); e != nil {
			return e
		}
		return transport.RunWithOptions(ctx, c, transport.Options{Prompts: p})
	case "clients":
		switch action {
		case "list":
			v, e := auth.ListClients(c.StateDir)
			if e != nil {
				return e
			}
			return printJSON(v)
		case "revoke", "revoke-all":
			if e := auth.RevokeClients(c.StateDir, id, action == "revoke-all"); e != nil {
				return e
			}
			return printJSON(map[string]any{"revoked": true})
		default:
			return errors.New("usage: clients list|revoke ID|revoke-all")
		}
	case "down":
		return transport.Down(ctx, c)
	case "status":
		rt, e := transport.Status(c)
		if e != nil {
			return e
		}
		return printJSON(rt)
	case "config":
		j, e := fsjail.New(c.Roots)
		if e != nil {
			return e
		}
		f, e := j.Directory(".")
		if f != nil {
			f.Close()
		}
		j.Close()
		if e != nil {
			return e
		}
		if e = c.Validate(false); e != nil {
			return e
		}
		return printJSON(map[string]any{"valid": true, "mode": c.Mode, "roots": c.Roots})
	case "doctor":
		tools := map[string]string{}
		for _, t := range []string{"systemd-run", "systemctl", "cloudflared", "codex", "visudo"} {
			p, _ := exec.LookPath(t)
			tools[t] = p
		}
		return printJSON(map[string]any{"name": identity.Name, "version": identity.Version, "go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "tools": tools, "mode": c.Mode})
	case "stdio":
		tty := prompt.Open()
		defer tty.Close()
		p := prompt.New(tty)
		if c.Headless {
			p = prompt.New(nil)
		}
		if e = privilege.Authorize(ctx, &c, p, os.Stderr, false); e != nil {
			return e
		}
		a, e := mcpserver.New(c, false)
		if e != nil {
			return e
		}
		defer a.Close()
		if e = a.ConfigurePrompts(ctx, p); e != nil {
			return e
		}
		return a.Server.Run(ctx, &mcp.StdioTransport{})
	case "tasks":
		binary, _ := os.Executable()
		tm, e := tasks.New(c, binary)
		if e != nil {
			return e
		}
		var v any
		switch action {
		case "":
			v, e = tm.List()
		case "status":
			v, e = tm.Status(id)
		case "logs":
			v, e = tm.Logs(id, 0)
		case "stop":
			v, e = tm.Stop(ctx, id)
		default:
			e = errors.New("usage: tasks [status|logs|stop ID]")
		}
		if e != nil {
			return e
		}
		return printJSON(v)
	default:
		return errors.New("unknown command")
	}
}
