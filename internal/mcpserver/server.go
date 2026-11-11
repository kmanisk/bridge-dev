package mcpserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/audit"
	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/events"
	"github.com/kmanisk/bridge-dev/internal/execrun"
	"github.com/kmanisk/bridge-dev/internal/filesystem"
	"github.com/kmanisk/bridge-dev/internal/fsjail"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"github.com/kmanisk/bridge-dev/internal/tasks"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"
)

type Input struct {
	Encoding string   `json:"encoding,omitempty"`
	Path     string   `json:"path,omitempty" jsonschema:"Path within configured roots; relative paths use the first root"`
	ID       string   `json:"id,omitempty" jsonschema:"Task ID; for fetch this is a file path"`
	Query    string   `json:"query,omitempty" jsonschema:"Case-insensitive filename substring"`
	Content  string   `json:"content,omitempty" jsonschema:"Replacement file contents; maximum 1 MiB"`
	Old      string   `json:"old,omitempty"`
	New      string   `json:"new,omitempty"`
	Argv     []string `json:"argv,omitempty" jsonschema:"Absolute executable followed by literal arguments; never a shell string"`
	Cwd      string   `json:"cwd,omitempty" jsonschema:"Explicit working directory within roots"`
	Timeout  int      `json:"timeout_seconds,omitempty"`
	Offset   int64    `json:"offset,omitempty" jsonschema:"Byte cursor returned by task_logs"`
	Sudo     bool     `json:"sudo,omitempty" jsonschema:"Explicit privileged task request; local sudo mode only"`
	ClientID string   `json:"client_id,omitempty" jsonschema:"Stable client-selected completion cursor identity"`
	Ack      string   `json:"ack,omitempty" jsonschema:"Acknowledge a previously returned task completion cursor"`
}
type App struct {
	Events *events.Hub
	Config config.Config
	Jail   *fsjail.Jail
	Tasks  *tasks.Manager
	Audit  *audit.Log
	Server *mcp.Server
}

func New(c config.Config, remote bool) (*App, error) {
	if c.Mode == policy.Dangerous && !c.AckDanger && !c.PrivilegedAuthorized {
		return nil, errors.New("dangerous preference requires current startup authorization")
	}
	if e := c.Validate(remote); e != nil {
		return nil, e
	}
	if e := platform.PrivateDir(c.StateDir); e != nil {
		return nil, e
	}
	roots := c.Roots
	if c.Mode == policy.Dangerous {
		roots = []string{"/"}
		c.Roots = roots
	}
	j, e := fsjail.New(roots)
	if e != nil {
		return nil, e
	}
	if c.Mode == policy.Dangerous {
		j.Unrestricted()
	}
	binary, e := os.Executable()
	if e != nil {
		j.Close()
		return nil, e
	}
	tm, e := tasks.New(c, binary)
	if e != nil {
		j.Close()
		return nil, e
	}
	al, e := audit.New(filepath.Join(c.StateDir, "audit"))
	if e != nil {
		j.Close()
		return nil, e
	}
	s := mcp.NewServer(&mcp.Implementation{Name: identity.Name, Version: identity.Version}, nil)
	a := &App{Config: c, Jail: j, Tasks: tm, Audit: al, Server: s, Events: events.New(string(c.Mode), nil)}
	s.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			result, e := next(ctx, method, req)
			name := ""
			if info, ok := req.(interface{ ClientInfo() *mcp.Implementation }); ok {
				if ci := info.ClientInfo(); ci != nil {
					name = ci.Name
				}
			}
			a.Events.Seen(auth.Client(ctx), name, auth.Client(ctx) != "stdio-local")
			if method == "tools/call" && e != nil {
				if ae := a.Audit.Write(audit.Record{Client: auth.Client(ctx), Operation: "invalid_or_unavailable_tool", Mode: string(c.Mode), Allowed: false, Phase: "result"}); ae != nil {
					return nil, errors.New("audit failure")
				}
			}
			return result, e
		}
	})

	if c.Probe {
		a.add("probe_read", "Read a harmless compatibility probe value", true)
		a.add("probe_write", "Dummy write probe; returns confirmation without changing user files", false)
		a.add("search", "Search allowed file names (read-only alias of fs_search)", true)
		a.add("fetch", "Read an allowed file (read-only alias of fs_read)", true)
		return a, nil
	}
	for _, t := range []struct{ n, d string }{{"fs_read", "Read a regular file within roots, at most 1 MiB"}, {"fs_list", "List at most 200 directory entries within roots"}, {"fs_search", "Search file names within roots, at most 200 matches"}, {"search", "Search allowed file names; alias of fs_search"}, {"fetch", "Read an allowed regular file; alias of fs_read"}, {"proc_list", "List process IDs, parents and names; arguments and environment excluded"}, {"task_list", "List durable tasks and final exit status"}, {"task_status", "Get one durable task status"}, {"task_logs", "Read task output incrementally using byte offsets"}, {"task_wait", "Wait at most 25 seconds for task completion"}} {
		a.add(t.n, t.d, true)
	}
	if c.Mode.Write() {
		for _, t := range []struct{ n, d string }{{"fs_write", "Write a regular file within roots, at most 1 MiB"}, {"fs_edit", "Replace old text exactly once in an allowed file"}, {"exec", "Run allowlisted argv with explicit cwd, timeout and bounded output"}, {"task_start", "Start durable allowlisted argv; survives MCP exit"}, {"task_stop", "Request graceful task termination before forced termination"}, {"task_restart", "Start a new task from completed task argv under current policy"}, {"task_forget", "Remove only terminal task metadata and logs"}} {
			a.add(t.n, t.d, false)
		}
	}
	if c.Mode.Privileged() {
		a.add("sudo_exec", "Run explicit sudo-allowlisted argv through sudo -n; never passwords", false)
	}
	return a, nil
}
func (a *App) Close() { a.Jail.Close() }
func (a *App) add(name, desc string, read bool) {
	f := name == "exec" || name == "sudo_exec" || name == "task_start" || name == "task_restart"
	mcp.AddTool(a.Server, &mcp.Tool{Name: name, Description: desc, InputSchema: inputSchema(name, a.Config.Mode.Privileged()), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: read, OpenWorldHint: &f}}, func(ctx context.Context, req *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
		start := time.Now()
		if info := req.ClientInfo(); info != nil {
			a.Events.Seen(auth.Client(ctx), info.Name, auth.Client(ctx) != "stdio-local")
		}
		a.Events.Tool(auth.Client(ctx), name)
		record := audit.Record{Phase: "intent", Client: auth.Client(ctx), Operation: name, Mode: string(a.Config.Mode), Sudo: name == "sudo_exec" || in.Sudo}
		// Audit intent before side effects. A failed audit append fails the operation.
		if e := a.Audit.Write(record); e != nil {
			return nil, nil, errors.New("audit unavailable; operation refused")
		}
		data, e := a.call(ctx, name, in)
		record.Phase = "result"
		record.DurationMS = time.Since(start).Milliseconds()
		record.Allowed = e == nil
		if r, ok := data.(execrun.Result); ok {
			record.ExitCode = &r.ExitCode
		}
		if t, ok := data.(tasks.Task); ok {
			record.TaskID = t.ID
			record.ExitCode = t.ExitCode
		}
		if ae := a.Audit.Write(record); ae != nil {
			return nil, nil, errors.New("audit completion could not be recorded")
		}
		if e != nil {
			a.Events.Emit("Denied operation: " + name)
			return nil, nil, e
		}
		result := map[string]any{"data": data}
		if in.ClientID != "" {
			client := auth.Hash(auth.Client(ctx) + ":" + in.ClientID)
			cursor, ce := a.Tasks.Cursor(client, in.Ack)
			if ce != nil {
				return nil, nil, ce
			}
			events, ce := a.Tasks.Events(cursor)
			if ce != nil {
				return nil, nil, ce
			}
			result["completions"] = events
			if len(events) > 0 {
				result["completion_cursor"] = events[len(events)-1].Cursor
			}
		}
		b, e := json.Marshal(result)
		if e != nil {
			return nil, nil, e
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}, result, nil
	})
}
func (a *App) call(ctx context.Context, name string, in Input) (any, error) {
	switch name {
	case "probe_read":
		return "probe read succeeded", nil
	case "probe_write":
		return "dummy write accepted; no user file changed", nil
	case "fs_read", "fetch":
		p := in.Path
		if p == "" {
			p = in.ID
		}
		b, e := a.Jail.Read(p, filesystem.MaxRead)
		if e != nil {
			return nil, e
		}
		if !utf8.Valid(b) {
			return map[string]string{"encoding": "base64", "content": base64.StdEncoding.EncodeToString(b)}, nil
		}
		return string(b), nil
	case "fs_list":
		return filesystem.List(a.Jail, in.Path)
	case "fs_search", "search":
		p := in.Path
		if p == "" {
			p = "."
		}
		return filesystem.Search(ctx, a.Jail, p, in.Query)
	case "fs_write":
		b := []byte(in.Content)
		switch in.Encoding {
		case "", "utf8":
		case "base64":
			if len(in.Content) > base64.StdEncoding.EncodedLen(filesystem.MaxRead) {
				return nil, errors.New("encoded write limit exceeded")
			}
			var e error
			b, e = base64.StdEncoding.DecodeString(in.Content)
			if e != nil {
				return nil, errors.New("invalid base64 content")
			}
		default:
			return nil, errors.New("unsupported encoding")
		}
		return "written", a.Jail.Write(in.Path, b)
	case "fs_edit":
		return "edited", a.Jail.Edit(in.Path, in.Old, in.New)
	case "proc_list":
		return platform.Processes(ctx)
	case "exec", "sudo_exec":
		return execrun.Run(ctx, a.Jail, policy.Commands{Allow: a.Config.Allow, Deny: a.Config.Deny, SudoAllow: a.Config.SudoAllow}, a.Config.Mode, execrun.Request{Argv: in.Argv, Cwd: in.Cwd, TimeoutSeconds: in.Timeout}, name == "sudo_exec", a.Config.Env)
	case "task_start":
		return a.Tasks.Start(ctx, a.Jail, execrun.Request{Argv: in.Argv, Cwd: in.Cwd}, in.Sudo)
	case "task_list":
		return a.Tasks.List()
	case "task_status":
		return a.Tasks.Status(in.ID)
	case "task_logs":
		return a.Tasks.Logs(in.ID, in.Offset)
	case "task_wait":
		return a.Tasks.Wait(ctx, in.ID, time.Duration(in.Timeout)*time.Second)
	case "task_stop":
		return a.Tasks.Stop(ctx, in.ID)
	case "task_restart":
		return a.Tasks.Restart(ctx, a.Jail, in.ID)
	case "task_forget":
		return "forgotten", a.Tasks.Forget(in.ID)
	default:
		return nil, fmt.Errorf("unsupported tool %s", name)
	}
}
