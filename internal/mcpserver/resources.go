package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"

	"github.com/kmanisk/bridge-dev/internal/audit"
	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Task resources are alternate read representations, never another authority.
// Under approve=all use the corresponding gated tool rather than bypassing it.
func (a *App) resources() {
	if a.Config.Approve == "all" {
		return
	}
	scheme := identity.Name + "-task"
	handler := func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		p := auth.Identity(ctx)
		if a.Remote && (!p.Authenticated || p.Scope != "mcp:"+string(a.Grant.Mode())) {
			return nil, auth.ErrUnauthorized
		}
		if p.Check != nil {
			if e := p.Check(); e != nil {
				return nil, e
			}
		}
		u, e := url.Parse(req.Params.URI)
		if e != nil || u.Scheme != scheme || u.Host != "" {
			return nil, errors.New("invalid task resource")
		}
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) != 2 {
			return nil, errors.New("invalid task resource path")
		}
		record := audit.Record{Client: p.ID, ClientName: p.Name, Operation: "task_resource", Mode: string(a.Grant.Mode()), Phase: "intent", TaskID: parts[0]}
		if e = a.Audit.Write(record); e != nil {
			return nil, e
		}
		var value any
		switch parts[1] {
		case "status":
			value, e = a.Tasks.Status(parts[0])
		case "logs":
			offset, err := strconv.ParseInt(u.Query().Get("offset"), 10, 64)
			if u.Query().Get("offset") == "" {
				offset = 0
				err = nil
			}
			if err != nil || offset < 0 {
				return nil, errors.New("invalid log offset")
			}
			value, e = a.Tasks.Logs(parts[0], offset)
		default:
			return nil, errors.New("unknown task resource")
		}
		record.Phase = "completed"
		record.Allowed = e == nil
		if e != nil {
			record.Reason = denialReason(e)
		}
		if ae := a.Audit.Write(record); ae != nil {
			return nil, ae
		}
		if e != nil {
			return nil, e
		}
		b, e := json.Marshal(value)
		if e != nil {
			return nil, e
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: req.Params.URI, MIMEType: "application/json", Text: string(b)}}}, nil
	}
	a.Server.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: scheme + ":///{id}/status", Name: "task_status", MIMEType: "application/json"}, handler)
	a.Server.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: scheme + ":///{id}/logs{?offset}", Name: "task_logs", MIMEType: "application/json"}, handler)
}
