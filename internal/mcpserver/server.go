package mcpserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/approval"
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
	"github.com/kmanisk/bridge-dev/internal/privilege"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/tasks"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Input struct {
	Limit         int64    `json:"limit,omitempty"`
	ContentSearch bool     `json:"content_search,omitempty"`
	RequestKey    string   `json:"request_key,omitempty" jsonschema:"Stable unique key per logical operation; reuse only for retries"`
	Encoding      string   `json:"encoding,omitempty"`
	Path          string   `json:"path,omitempty" jsonschema:"Path authorized by effective mode; ordinary relative paths use the first root, dangerous uses /"`
	ID            string   `json:"id,omitempty" jsonschema:"Task ID; for fetch this is a file path"`
	Query         string   `json:"query,omitempty" jsonschema:"Case-insensitive filename substring, or literal file contents when content_search=true"`
	Content       string   `json:"content,omitempty" jsonschema:"Replacement contents within configured write byte bound"`
	Old           string   `json:"old,omitempty"`
	New           string   `json:"new,omitempty"`
	Argv          []string `json:"argv,omitempty" jsonschema:"Absolute executable followed by literal arguments; never a shell string"`
	Cwd           string   `json:"cwd,omitempty" jsonschema:"Explicit working directory within roots"`
	Timeout       int      `json:"timeout_seconds,omitempty"`
	Offset        int64    `json:"offset,omitempty" jsonschema:"Byte cursor for task logs, file slices and paginated file operations"`
	Sudo          bool     `json:"sudo,omitempty" jsonschema:"Explicit privileged task request; requires effective sudo/dangerous authorization"`
	ClientID      string   `json:"client_id,omitempty" jsonschema:"Stable client-selected completion cursor identity"`
	Ack           string   `json:"ack,omitempty" jsonschema:"Acknowledge a previously returned task completion cursor"`
}
type App struct {
	Prompts         *prompt.Coordinator
	registryMu      sync.Mutex
	registryExpired bool
	Grant           *privilege.Grant
	SafeJail        *fsjail.Jail
	Approvals       *approval.Manager
	Remote          bool
	Events          *events.Hub
	Config          config.Config
	Jail            *fsjail.Jail
	Tasks           *tasks.Manager
	Audit           *audit.Log
	Server          *mcp.Server
}

func New(c config.Config, remote bool) (*App, error) {
	if c.Mode.Privileged() && !c.PrivilegedAuthorized {
		return nil, errors.New("privileged preference requires current startup authorization")
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
	}
	j, e := fsjail.New(roots)
	if e != nil {
		return nil, e
	}
	if c.Mode == policy.Dangerous {
		j.Unrestricted()
	}
	if e = j.Check(); e != nil {
		j.Close()
		return nil, e
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
	a := &App{Config: c, Jail: j, Tasks: tm, Audit: al, Server: s, Events: events.New(string(c.Mode), nil), Remote: remote}
	initialized := false
	defer func() {
		if !initialized {
			a.Close()
		}
	}()
	if c.Mode == policy.Dangerous {
		if len(c.Roots) == 0 {
			a.SafeJail = fsjail.Deny()
		} else {
			a.SafeJail, e = fsjail.New(c.Roots)
			if e != nil {
				a.SafeJail = fsjail.Deny()
				e = nil
			}
		}
		if e != nil {
			j.Close()
			return nil, e
		}
	} else {
		a.SafeJail = j
	}
	j.ReadLimit = c.ReadBytes
	j.WriteLimit = c.WriteBytes
	if a.SafeJail != j {
		a.SafeJail.ReadLimit = c.ReadBytes
		a.SafeJail.WriteLimit = c.WriteBytes
		if c.ReadBytes == 0 {
			a.SafeJail.ReadLimit = filesystem.MaxRead
		}
		if c.WriteBytes == 0 {
			a.SafeJail.WriteLimit = filesystem.MaxRead
		}
	}
	duration, _ := time.ParseDuration(c.SudoFor)
	a.Grant = privilege.New(c.Mode, duration, func() {
		fallback := a.Config.PreviousMode
		if fallback == "" {
			fallback = policy.Readonly
		}
		a.Events.SetMode(string(fallback))
		a.Events.Emit("Privileged grant expired; effective mode " + string(fallback))
		_ = a.Audit.Write(audit.Record{Client: "terminal", Operation: "grant_expired", Mode: string(fallback), Phase: "expired", Reason: "expired"})
	})
	a.Grant.SetFallback(c.PreviousMode)
	if c.Mode.Privileged() {
		if e = a.Audit.Write(audit.Record{Client: "terminal", Operation: "grant_created", Mode: string(c.Mode), Phase: "approved", Allowed: true}); e != nil {
			j.Close()
			return nil, e
		}
	}

	if e = a.ConfigurePrompts(context.Background(), nil); e != nil {
		j.Close()
		return nil, e
	}
	s.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			a.RefreshTools()
			result, e := next(ctx, method, req)
			name := ""
			if info, ok := req.(interface{ ClientInfo() *mcp.Implementation }); ok {
				if ci := info.ClientInfo(); ci != nil {
					name = ci.Name
				}
			}
			if method == "initialize" {
				if ip, ok := req.GetParams().(*mcp.InitializeParams); ok && ip.ClientInfo != nil {
					name = ip.ClientInfo.Name
				}
			}
			a.Events.Seen(auth.Client(ctx), name, auth.Client(ctx) != "stdio-local")
			failed := e != nil
			if cr, ok := result.(*mcp.CallToolResult); ok && cr.IsError {
				failed = true
			}
			if method == "tools/call" && failed {
				if ae := a.Audit.Write(audit.Record{Client: auth.Client(ctx), Operation: "invalid_or_unavailable_tool", Mode: string(a.Grant.Mode()), Reason: "invalid_request", Allowed: false, Phase: "denied"}); ae != nil {
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
		initialized = true
		return a, nil
	}
	a.resources()
	for _, t := range []struct{ n, d string }{{"fs_read", "Read an authorized regular file; offset/limit select bounded byte slices"}, {"fs_list", "List authorized directory entries; offset/limit enable continuation metadata"}, {"fs_search", "Search authorized file names or content_search=true; offset/limit enable continuation metadata"}, {"search", "Search allowed file names; alias of fs_search"}, {"fetch", "Read an allowed regular file; alias of fs_read"}, {"proc_list", "List process IDs, parents and names; arguments and environment excluded"}, {"task_list", "List durable tasks and final exit status"}, {"task_status", "Get one durable task status"}, {"task_logs", "Read task output incrementally using byte offsets"}, {"task_wait", "Wait at most 25 seconds for task completion"}, {"approval_status", "Poll an approval or operation result using its pending ID; only its originating client session may retrieve it"}} {
		a.add(t.n, t.d, true)
	}
	if c.Mode.Write() {
		for _, t := range []struct{ n, d string }{{"fs_write", "Atomically write an authorized regular file within configured byte bound"}, {"fs_edit", "Replace old text exactly once in an allowed file"}, {"exec", "Run literal argv under effective command policy, explicit cwd, deadline and output bound"}, {"task_start", "Start durable literal argv under effective policy; survives MCP exit"}, {"task_stop", "Request graceful task termination before forced termination"}, {"task_restart", "Start a new task from completed task argv under current policy"}, {"task_forget", "Remove only terminal task metadata and logs"}} {
			a.add(t.n, t.d, false)
		}
	}
	if c.Mode.Privileged() {
		a.add("sudo_exec", "Run argv as root through sudo -n; any command unless sudo_commands is configured; never passwords", false)
		if c.Mode == policy.Dangerous && c.Shell {
			a.add("shell", "Run explicit shell source in dangerous mode only", false)
		}
	}
	initialized = true
	return a, nil
}
func (a *App) Close() {
	if a.Approvals != nil {
		a.Approvals.Close()
	}
	if a.Jail != nil {
		a.Jail.Close()
	}
	if a.SafeJail != nil && a.SafeJail != a.Jail {
		a.SafeJail.Close()
	}
}
func (a *App) add(name, desc string, read bool) {
	f := name == "exec" || name == "sudo_exec" || name == "task_start" || name == "task_restart"
	mcp.AddTool(a.Server, &mcp.Tool{Name: name, Description: desc, InputSchema: inputSchema(name, a.Grant.Mode().Privileged()), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: read, OpenWorldHint: &f}}, func(ctx context.Context, req *mcp.CallToolRequest, in Input) (*mcp.CallToolResult, any, error) {
		start := time.Now()
		if info := req.ClientInfo(); info != nil {
			a.Events.Seen(auth.Client(ctx), info.Name, auth.Client(ctx) != "stdio-local")
		}
		a.Events.Tool(auth.Client(ctx), name)
		if name == "task_restart" {
			r, sudo, e := a.Tasks.Execution(in.ID)
			if e != nil {
				return nil, nil, e
			}
			in.Argv = r.Argv
			in.Cwd = r.Cwd
			in.Sudo = sudo
		}
		opmeta := a.operation(name, in)
		record := audit.Record{ClientName: auth.Identity(ctx).Name, Path: opmeta.Path, Resolved: opmeta.Resolved, Cwd: opmeta.Cwd, Category: opmeta.Class, Phase: "intent", Client: auth.Client(ctx), Operation: name, Mode: string(a.Grant.Mode()), Sudo: name == "sudo_exec" || in.Sudo}
		// Audit intent before side effects. A failed audit append fails the operation.
		if e := a.Audit.Write(record); e != nil {
			return nil, nil, errors.New("audit unavailable; operation refused")
		}
		principal := auth.Identity(ctx)
		var data any
		var e error
		authorize := func() error {
			if a.Remote && !principal.Authenticated {
				return auth.ErrUnauthorized
			}
			if a.Remote && principal.Scope != "mcp:"+opmeta.Mode {
				return auth.Denied{Reason: "mode"}
			}
			if principal.Check != nil {
				if e := principal.Check(); e != nil {
					return e
				}
			}
			if e := a.Authorize(name, in, opmeta.Mode); e != nil {
				return e
			}
			return nil
		}
		if e = authorize(); e == nil {
			if name == "approval_status" || name == "task_wait" && len(in.ID) == 43 {
				if in.Timeout < 0 || in.Timeout > 25 {
					e = errors.New("wait limit is 25 seconds")
				} else {
					data, e = a.Approvals.Status(ctx, principal, in.ID, time.Duration(in.Timeout)*time.Second)
				}
			} else {
				op := a.operation(name, in)
				if op.Class == "read" && !a.Approvals.Gated(op) {
					data, e = a.call(ctx, name, in)
				} else {
					wait := time.Duration(-1)
					if a.Remote {
						wait = 24 * time.Second
						if !principal.CallDeadline.IsZero() {
							wait = max(0, time.Until(principal.CallDeadline))
						}
					}
					var response approval.Response
					response, e = a.Approvals.Submit(ctx, principal, op, authorize, func(run context.Context) (any, error) {
						if name == "sudo_exec" && a.Prompts.Available() {
							if e := execrun.SudoAvailable(run); e != nil {
								sudo, se := exec.LookPath("sudo")
								if se != nil {
									return nil, se
								}
								authctx, cancel := context.WithTimeout(run, 120*time.Second)
								defer cancel()
								if e = a.Prompts.Run(authctx, []string{sudo, "-v"}); e != nil {
									return nil, errors.New("sudo authentication failed")
								}
							}
						}
						if e := authorize(); e != nil {
							return nil, e
						}
						value, e := a.call(auth.WithPrincipal(run, principal), name, in)
						if task, ok := value.(tasks.Task); ok && e == nil && (name == "task_start" || name == "task_restart") {
							a.Events.Emit("Task " + task.ID + " started")
						}
						return value, e
					}, wait)
					if e == nil {
						if response.Status == "completed" {
							if response.Error != "" {
								e = errors.New(response.Error)
							} else {
								e = json.Unmarshal(response.Data, &data)
							}
						} else if response.Status == "denied" {
							e = errors.New(response.Error)
						} else {
							data = response
						}
					}
				}
			}
		}
		record.Phase = "completed"
		record.DurationMS = time.Since(start).Milliseconds()
		record.Allowed = e == nil
		if pending, ok := data.(approval.Response); ok {
			record.Phase = pending.Status
			if pending.Status == "pending" {
				record.Pending = true
				record.Allowed = false
			}
		}
		if e != nil {
			record.Phase = "denied"
			record.Reason = denialReason(e)
		}
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
	mode := a.Grant.Mode()
	recheck := func() error {
		if e := a.Authorize(name, in, string(mode)); e != nil {
			return e
		}
		if p := auth.Identity(ctx); p.Check != nil {
			return p.Check()
		}
		return nil
	}
	j := a.Jail
	if mode != policy.Dangerous {
		j = a.SafeJail
	}
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
		if in.Offset != 0 || in.Limit != 0 {
			return filesystem.ReadSlice(j, p, in.Offset, in.Limit, j.ReadLimit)
		}
		b, e := j.Read(p, j.ReadLimit)
		if e != nil {
			return nil, e
		}
		if !utf8.Valid(b) {
			return map[string]string{"encoding": "base64", "content": base64.StdEncoding.EncodeToString(b)}, nil
		}
		return string(b), nil
	case "fs_list":
		page, e := filesystem.ListPage(j, in.Path, in.Offset, int(in.Limit), a.Config.SearchResults)
		if in.Offset != 0 || in.Limit != 0 {
			return page, e
		}
		return page.Entries, e
	case "fs_search", "search":
		p := in.Path
		if p == "" {
			p = "."
		}
		page, e := filesystem.SearchPage(ctx, j, p, in.Query, filesystem.SearchOptions{Offset: in.Offset, Limit: int(in.Limit), Results: a.Config.SearchResults, Visited: a.Config.SearchVisited, Depth: a.Config.SearchDepth, ReadBytes: j.ReadLimit, Content: in.ContentSearch})
		if in.ContentSearch || in.Offset != 0 || in.Limit != 0 {
			return page, e
		}
		return page.Entries, e
	case "fs_write":
		b := []byte(in.Content)
		switch in.Encoding {
		case "", "utf8":
		case "base64":
			if j.WriteLimit > 0 && int64(len(in.Content)) > (j.WriteLimit+2)/3*4 {
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
		return "written", j.Write(in.Path, b)
	case "fs_edit":
		return "edited", j.Edit(in.Path, in.Old, in.New)
	case "proc_list":
		return platform.Processes(ctx)
	case "shell":
		if mode != policy.Dangerous || !a.Config.Shell {
			return nil, errors.New("mode forbids shell")
		}
		in.Argv = []string{"/bin/sh", "-c", in.Content}
		fallthrough
	case "exec", "sudo_exec":
		deadline, _ := time.ParseDuration(a.Config.ExecTimeout)
		maximum, _ := time.ParseDuration(a.Config.ExecMaxTimeout)
		return execrun.RunWithLimits(ctx, j, policy.Commands{Allow: a.Config.Allow, Deny: a.Config.Deny, SudoAllow: a.Config.SudoAllow}, mode, execrun.Request{Argv: in.Argv, Cwd: in.Cwd, TimeoutSeconds: in.Timeout, Authorize: recheck}, name == "sudo_exec", a.Config.Env, a.Config.OutputBytes, deadline, maximum)
	case "task_start":
		tm := *a.Tasks
		tm.Config.Mode = mode
		tm.Config.GrantUntil = a.Grant.Expiry()
		return tm.Start(ctx, j, execrun.Request{Argv: in.Argv, Cwd: in.Cwd, Authorize: recheck}, in.Sudo)
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
		tm := *a.Tasks
		tm.Config.Mode = mode
		tm.Config.GrantUntil = a.Grant.Expiry()
		if old, e := a.Tasks.Status(in.ID); e != nil || old.State == "running" || old.State == "starting" {
			return nil, errors.New("stop task before restart")
		}
		return tm.Start(ctx, j, execrun.Request{Argv: in.Argv, Cwd: in.Cwd, Authorize: recheck}, in.Sudo)
	case "task_forget":
		return "forgotten", a.Tasks.Forget(in.ID)
	default:
		return nil, fmt.Errorf("unsupported tool %s", name)
	}
}

// ConfigurePrompts is called before serving; the shared coordinator serializes
// consent, tool approval, startup and sudo terminal interaction.
func (a *App) ConfigurePrompts(ctx context.Context, p *prompt.Coordinator) error {
	a.Prompts = p
	if a.Approvals != nil {
		a.Approvals.Close()
	}
	m, e := approval.New(ctx, a.Config.StateDir, a.Config.Approve, p, func(op approval.Operation, id, status, reason string) error {
		if status == "pending" || status == "approved" || status == "denied" {
			a.Events.Emit("Operation " + status + ": " + op.Tool)
		}
		return a.Audit.Write(audit.Record{Client: op.Client, ClientName: op.Name, Operation: op.Tool, Mode: op.Mode, Category: op.Class, Path: op.Path, Resolved: op.Resolved, Cwd: op.Cwd, ApprovalID: id, Phase: status, Reason: reason, DurationMS: op.DurationMS, ExitCode: op.ExitCode, TaskID: op.TaskID, Allowed: status == "approved", Sudo: op.Class == "sudo"})
	})
	if e == nil {
		m.MaxPending = a.Config.ApprovalPending
		a.Approvals = m
	}
	return e
}
func (a *App) operation(name string, in Input) approval.Operation {
	class := "read"
	switch name {
	case "fs_write", "fs_edit", "probe_write":
		class = "write"
	case "exec", "shell":
		class = "exec"
	case "task_start", "task_stop", "task_restart", "task_forget":
		class = "task_mutation"
	case "sudo_exec":
		class = "sudo"
	}
	if in.Sudo {
		class = "sudo"
	}
	j := a.Jail
	if a.Grant.Mode() != policy.Dangerous {
		j = a.SafeJail
	}
	path := in.Path
	if name == "fetch" {
		path = in.ID
	}
	resolved := ""
	if path != "" {
		resolved, _ = j.Path(path)
	}
	cwd := in.Cwd
	if cwd != "" {
		cwd, _ = j.Path(cwd)
	}
	copy := in
	copy.ClientID = ""
	copy.Ack = ""
	copy.RequestKey = ""
	digest, _ := approval.Digest(struct {
		Tool, Mode, Path, Cwd string
		Input                 Input
	}{name, string(a.Grant.Mode()), resolved, cwd, copy})
	display := fmt.Sprintf("path %q (resolved %q)", path, resolved)
	if name == "shell" {
		display = fmt.Sprintf("argv %q", []string{"/bin/sh", "-c", in.Content})
	}
	if len(in.Argv) > 0 {
		display = fmt.Sprintf("argv %q", in.Argv)
	}
	if strings.HasPrefix(name, "task_") {
		display += fmt.Sprintf(" task %q", in.ID)
	}
	return approval.Operation{Tool: name, Class: class, Mode: string(a.Grant.Mode()), Path: path, Resolved: resolved, Cwd: cwd, Digest: digest, RequestKey: in.RequestKey, Display: display}
}

func denialReason(e error) string {
	var d auth.Denied
	if errors.As(e, &d) {
		return d.Reason
	}
	s := e.Error()
	switch {
	case strings.Contains(s, "outside allowed"):
		return "outside_roots"
	case strings.Contains(s, "symlink") || strings.Contains(s, "too many levels"):
		return "symlink_escape"
	case strings.Contains(s, "denied by user"):
		return "user_denied"
	case strings.Contains(s, "operation denied: expired"):
		return "expired"
	case strings.Contains(s, "operation denied: revoked"):
		return "revoked"
	case strings.Contains(s, "mode"):
		return "mode"
	case errors.Is(e, auth.ErrUnauthorized):
		return "auth"
	case strings.Contains(s, "request_key"):
		return "invalid_request"
	default:
		return "policy"
	}
}

func (a *App) Authorize(name string, in Input, expected string) error {
	mode := a.Grant.Mode()
	if string(mode) != expected {
		return auth.Denied{Reason: "expired"}
	}
	write := false
	switch name {
	case "fs_write", "fs_edit", "exec", "task_start", "task_stop", "task_restart", "task_forget":
		write = true
	case "sudo_exec", "shell":
		if !mode.Privileged() {
			return auth.Denied{Reason: "mode"}
		}
	}
	if write && !mode.Write() || in.Sudo && !mode.Privileged() || name == "shell" && (mode != policy.Dangerous || !a.Config.Shell) {
		return auth.Denied{Reason: "mode"}
	}
	return nil
}
func (a *App) RefreshTools() {
	a.registryMu.Lock()
	defer a.registryMu.Unlock()
	mode := a.Grant.Mode()
	if mode == a.Config.Mode || a.registryExpired {
		return
	}
	a.registryExpired = true
	a.Server.RemoveTools("sudo_exec", "shell")
	if !mode.Write() {
		a.Server.RemoveTools("fs_write", "fs_edit", "exec", "task_start", "task_stop", "task_restart", "task_forget")
	} else {
		a.Server.RemoveTools("task_start")
		a.add("task_start", "Start durable literal argv under effective policy; survives MCP exit", false)
	}
	a.Events.SetMode(string(mode))
}
