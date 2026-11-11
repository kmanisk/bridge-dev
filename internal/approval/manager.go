// Package approval implements human gates and durable at-most-once dispatch.
package approval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/prompt"
)

type Operation struct {
	Tool       string `json:"tool"`
	Class      string `json:"class"`
	Mode       string `json:"mode"`
	Path       string `json:"requested_path,omitempty"`
	Resolved   string `json:"resolved_path,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	Digest     string `json:"digest"`
	Client     string `json:"client"`
	Name       string `json:"client_name,omitempty"`
	Session    string `json:"session"`
	Scope      string `json:"scope"`
	Origin     string `json:"origin"`
	Display    string `json:"-"`
	RequestKey string `json:"-"`
}
type Response struct {
	ID      string          `json:"pending_id"`
	Status  string          `json:"status"`
	Outcome string          `json:"outcome,omitempty"`
	Client  string          `json:"client"`
	Expires time.Time       `json:"expires"`
	Next    string          `json:"next_poll,omitempty"`
	Data    json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
	Reason  string          `json:"reason,omitempty"`
}
type record struct {
	Operation     Operation `json:"operation"`
	Response      Response  `json:"response"`
	OwnerPID      int       `json:"owner_pid"`
	OwnerIdentity string    `json:"owner_identity"`
	Epoch         string    `json:"epoch"`
}
type AuditFunc func(Operation, string, string, string) error
type job struct {
	done      chan struct{}
	authorize func() error
	invoke    func(context.Context) (any, error)
	op        Operation
}
type Manager struct {
	mu         sync.Mutex
	dir        string
	epoch      string
	pid        int
	identity   string
	p          *prompt.Coordinator
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	jobs       map[string]*job
	always     map[string]bool
	Policy     string
	Timeout    time.Duration
	MaxPending int
	Audit      AuditFunc
}

func New(ctx context.Context, state, policy string, p *prompt.Coordinator, audit AuditFunc) (*Manager, error) {
	dir := filepath.Join(state, "requests")
	if e := platform.PrivateDir(dir); e != nil {
		return nil, e
	}
	pid := os.Getpid()
	identity, e := platform.ProcessIdentity(pid)
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Manager{dir: dir, epoch: auth.Random(), pid: pid, identity: identity, p: p, ctx: ctx, cancel: cancel, jobs: map[string]*job{}, always: map[string]bool{}, Policy: policy, Timeout: 120 * time.Second, MaxPending: 64, Audit: audit}, nil
}
func (m *Manager) Close() { m.cancel(); m.wg.Wait() }
func Digest(v any) (string, error) {
	b, e := json.Marshal(v)
	if e != nil {
		return "", e
	}
	return auth.Hash(string(b)), nil
}
func (m *Manager) Gated(op Operation) bool {
	switch m.Policy {
	case "none":
		return false
	case "all":
		return true
	case "write":
		return op.Class != "read"
	case "sudo":
		return op.Class == "sudo" || op.Mode == "dangerous" && op.Class != "read"
	default:
		return true
	}
}
func (m *Manager) alwaysKey(op Operation) string {
	return auth.Hash(op.Client + "\x00" + op.Session + "\x00" + op.Scope + "\x00" + op.Origin + "\x00" + op.Mode + "\x00" + op.Class)
}
func (m *Manager) file(id string) (string, error) {
	if len(id) != 43 || strings.ContainsAny(id, "/\\.\x00") {
		return "", errors.New("approval not found")
	}
	return filepath.Join(m.dir, id+".json"), nil
}
func (m *Manager) save(r record) error {
	p, e := m.file(r.Response.ID)
	if e != nil {
		return e
	}
	return platform.AtomicJSON(p, r)
}
func (m *Manager) load(id string) (record, error) {
	p, e := m.file(id)
	if e != nil {
		return record{}, e
	}
	var r record
	e = platform.ReadJSON(p, &r)
	return r, e
}
func (m *Manager) transition(r *record, status, reason string) error {
	if m.Audit != nil {
		if e := m.Audit(r.Operation, r.Response.ID, status, reason); e != nil {
			return e
		}
	}
	r.Response.Status = status
	r.Response.Reason = reason
	r.Response.Next = "approval_status"
	if status == "denied" {
		r.Response.Outcome = "denied"
		if reason == "user_denied" {
			r.Response.Error = "denied by user"
		} else {
			r.Response.Error = "operation denied: " + reason
		}
	}
	return m.save(*r)
}
func boundTo(p auth.Principal, op Operation) bool {
	return p.ID == op.Client && p.Session == op.Session && p.Scope == op.Scope && p.Origin == op.Origin
}
func (m *Manager) Submit(ctx context.Context, p auth.Principal, op Operation, authorize func() error, invoke func(context.Context) (any, error), wait time.Duration) (Response, error) {
	if p.Check != nil {
		if e := p.Check(); e != nil {
			return Response{}, e
		}
	}
	if e := authorize(); e != nil {
		return Response{}, e
	}
	op.Client = p.ID
	op.Name = p.Name
	op.Session = p.Session
	op.Scope = p.Scope
	op.Origin = p.Origin
	gated := m.Gated(op)
	if op.RequestKey == "" && (op.Class != "read" || gated) {
		return Response{}, errors.New("request_key is required: use one stable unique key per logical operation and reuse it only for retries")
	}
	if len(op.RequestKey) > 256 {
		return Response{}, errors.New("request_key too long")
	}
	if op.RequestKey == "" {
		op.RequestKey = auth.Random()
	}
	key := auth.Hash(p.ID + "\x00" + op.RequestKey)
	unlock, e := platform.Lock(filepath.Join(m.dir, "key-"+key+".lock"))
	if e != nil {
		return Response{}, e
	}
	var existing string
	e = platform.ReadJSON(filepath.Join(m.dir, "key-"+key+".json"), &existing)
	if e == nil {
		unlock()
		saved, e := m.load(existing)
		if e != nil {
			return Response{}, e
		}
		if saved.Operation.Digest != op.Digest || saved.Operation.Mode != op.Mode || !boundTo(p, saved.Operation) {
			return Response{}, errors.New("invalid_request: request_key was reused for a modified operation")
		}
		return m.await(ctx, p, existing, wait)
	}
	if !os.IsNotExist(e) {
		unlock()
		return Response{}, e
	}
	m.mu.Lock()
	if m.MaxPending > 0 && len(m.jobs) >= m.MaxPending {
		m.mu.Unlock()
		unlock()
		return Response{}, errors.New("concurrent operation queue full")
	}
	id := auth.Random()
	r := record{Operation: op, Response: Response{ID: id, Status: "pending", Client: p.ID, Expires: time.Now().UTC().Add(m.Timeout), Next: "approval_status"}, OwnerPID: m.pid, OwnerIdentity: m.identity, Epoch: m.epoch}
	j := &job{done: make(chan struct{}), authorize: authorize, invoke: invoke, op: op}
	if e = m.transition(&r, "pending", ""); e == nil {
		e = platform.AtomicJSON(filepath.Join(m.dir, "key-"+key+".json"), id)
	}
	if e != nil {
		m.mu.Unlock()
		unlock()
		return Response{}, e
	}
	m.jobs[id] = j
	m.wg.Add(1)
	m.mu.Unlock()
	unlock()
	go m.run(r, j, gated)
	if gated {
		return r.Response, nil
	}
	return m.await(ctx, p, id, wait)
}
func (m *Manager) run(r record, j *job, gated bool) {
	defer m.wg.Done()
	defer func() { m.mu.Lock(); delete(m.jobs, r.Response.ID); close(j.done); m.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(m.ctx, m.Timeout)
	defer cancel()
	deny := func(reason string) {
		if e := m.transition(&r, "denied", reason); e != nil {
			r.Response.Status = "denied"
			r.Response.Error = "audit/state persistence failure"
			_ = m.save(r)
		}
	}
	check := func() error {
		if e := ctx.Err(); e != nil {
			return e
		}
		return j.authorize()
	}
	if e := check(); e != nil {
		deny(reason(e))
		return
	}
	m.mu.Lock()
	auto := m.always[m.alwaysKey(j.op)]
	m.mu.Unlock()
	if gated && !auto {
		if m.p == nil || !m.p.Available() {
			deny("user_denied")
			return
		}
		text := fmt.Sprintf("Tool: %s\nClient: %s (self-reported name %q)\nClass: %s\nMode: %s\nWorking directory: %q\nOperation: %s\nApprove? [y/N/a] (a allows this class only for this authenticated session) ", j.op.Tool, j.op.Client, j.op.Name, j.op.Class, j.op.Mode, j.op.Cwd, j.op.Display)
		answer, e := m.p.Ask(ctx, text)
		if e != nil {
			deny(reason(e))
			return
		}
		answer = strings.ToLower(strings.TrimSpace(answer))
		if answer != "y" && answer != "a" {
			deny("user_denied")
			return
		}
		if answer == "a" {
			m.mu.Lock()
			m.always[m.alwaysKey(j.op)] = true
			m.mu.Unlock()
		}
	}
	if e := check(); e != nil {
		deny(reason(e))
		return
	}
	if e := m.transition(&r, "approved", ""); e != nil {
		deny("policy")
		return
	}
	if e := check(); e != nil {
		deny(reason(e))
		return
	}
	if e := m.transition(&r, "dispatched", ""); e != nil {
		deny("policy")
		return
	}
	// The durable dispatched state is the at-most-once boundary. A crash after
	// this point is unknown, never permission to rerun automatically.
	if e := check(); e != nil {
		deny(reason(e))
		return
	}
	value, e := j.invoke(m.ctx)
	data, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		e = marshalErr
	}
	r.Response.Data = data
	r.Response.Outcome = "completed"
	if e != nil {
		r.Response.Outcome = "error"
		r.Response.Error = e.Error()
	}
	if e = m.transition(&r, "completed", ""); e != nil {
		r.Response.Status = "unknown"
		r.Response.Outcome = "unknown"
		r.Response.Data = nil
		r.Response.Error = "outcome unknown: result persistence failed"
		_ = m.save(r)
	}
}
func reason(e error) string {
	var denied auth.Denied
	if errors.As(e, &denied) {
		return denied.Reason
	}
	if errors.Is(e, context.DeadlineExceeded) || errors.Is(e, context.Canceled) {
		return "expired"
	}
	return "policy"
}
func (m *Manager) await(ctx context.Context, p auth.Principal, id string, wait time.Duration) (Response, error) {
	m.mu.Lock()
	j := m.jobs[id]
	m.mu.Unlock()
	if j != nil && wait != 0 {
		if wait < 0 {
			select {
			case <-j.done:
			case <-ctx.Done():
				return Response{}, ctx.Err()
			}
		} else {
			timer := time.NewTimer(min(wait, 24*time.Second))
			defer timer.Stop()
			select {
			case <-j.done:
			case <-ctx.Done():
				return Response{}, ctx.Err()
			case <-timer.C:
			}
		}
	}
	return m.Status(ctx, p, id, 0)
}
func (m *Manager) Status(ctx context.Context, p auth.Principal, id string, wait time.Duration) (Response, error) {
	if p.Check != nil {
		if e := p.Check(); e != nil {
			return Response{}, e
		}
	}
	r, e := m.load(id)
	if e != nil || !boundTo(p, r.Operation) {
		return Response{}, errors.New("approval not found")
	}
	if wait > 0 {
		if wait > 25*time.Second {
			return Response{}, errors.New("approval long-poll limit is 25 seconds")
		}
		return m.await(ctx, p, id, min(wait, 24*time.Second))
	}
	if r.Response.Status == "pending" || r.Response.Status == "approved" || r.Response.Status == "dispatched" {
		identity, e := platform.ProcessIdentity(r.OwnerPID)
		alive := e == nil && identity == r.OwnerIdentity
		if r.OwnerPID == m.pid && r.Epoch != m.epoch {
			alive = false
		}
		if !alive {
			if r.Response.Status == "dispatched" {
				r.Response.Status = "unknown"
				r.Response.Outcome = "unknown"
				r.Response.Error = "outcome unknown after dispatcher exit; not automatically retried"
				if e = m.save(r); e != nil {
					return Response{}, e
				}
			} else {
				if e = m.transition(&r, "denied", "expired"); e != nil {
					return Response{}, e
				}
			}
		}
	}
	return r.Response, nil
}
