package auth

import (
	"errors"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type ClientInfo struct {
	ID           string    `json:"id"`
	Name         string    `json:"self_reported_name"`
	Registration string    `json:"registration"`
	Scopes       []string  `json:"scopes"`
	Origin       string    `json:"origin"`
	Created      time.Time `json:"created"`
	Expires      time.Time `json:"expires"`
	LastActivity time.Time `json:"last_activity"`
	Revoked      bool      `json:"revoked"`
}
type revocations struct {
	Clients   map[string]bool
	AllBefore time.Time
}

func revocationState(dir string) (revocations, error) {
	var r revocations
	e := platform.ReadJSON(filepath.Join(dir, "client-revocations.json"), &r)
	if os.IsNotExist(e) {
		e = nil
	}
	if r.Clients == nil {
		r.Clients = map[string]bool{}
	}
	return r, e
}
func (o *OAuth) clientRevoked(id string) bool {
	r, e := revocationState(o.state)
	if e != nil {
		return true
	}
	c, ok := o.db.Clients[id]
	return !ok || r.Clients[id] || !r.AllBefore.IsZero() && !c.Created.After(r.AllBefore)
}
func oauthDirectories(state string) ([]string, error) {
	dirs := []string{}
	candidates := []string{filepath.Join(state, "oauth")}
	origins, e := filepath.Glob(filepath.Join(state, "origins", "*", "oauth"))
	if e != nil {
		return nil, e
	}
	candidates = append(candidates, origins...)
	for _, p := range candidates {
		if s, e := os.Lstat(p); e == nil && s.IsDir() && s.Mode().Perm()&0077 == 0 {
			dirs = append(dirs, p)
		}
	}
	return dirs, nil
}
func ListClients(state string) ([]ClientInfo, error) {
	dirs, e := oauthDirectories(state)
	if e != nil {
		return nil, e
	}
	out := []ClientInfo{}
	for _, dir := range dirs {
		var db database
		if e = platform.ReadJSON(filepath.Join(dir, "store.json"), &db); e != nil {
			return nil, e
		}
		r, e := revocationState(dir)
		if e != nil {
			return nil, e
		}
		for _, c := range db.Clients {
			out = append(out, ClientInfo{ID: c.ID, Name: c.Name, Registration: "dynamic", Scopes: c.Scopes, Origin: db.Issuer, Created: c.Created, Expires: c.Expires, LastActivity: c.LastActivity, Revoked: r.Clients[c.ID] || !r.AllBefore.IsZero() && !c.Created.After(r.AllBefore)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
func RevokeClients(state, id string, all bool) error {
	dirs, e := oauthDirectories(state)
	if e != nil {
		return e
	}
	found := all
	for _, dir := range dirs {
		var db database
		if e = platform.ReadJSON(filepath.Join(dir, "store.json"), &db); e != nil {
			return e
		}
		if _, ok := db.Clients[id]; !all && !ok {
			continue
		}
		found = true
		unlock, e := platform.Lock(filepath.Join(dir, "client-revocations.lock"))
		if e != nil {
			return e
		}
		r, e := revocationState(dir)
		if e == nil {
			if all {
				r.AllBefore = time.Now().UTC()
			} else {
				r.Clients[id] = true
			}
			e = platform.AtomicJSON(filepath.Join(dir, "client-revocations.json"), r)
		}
		unlock()
		if e != nil {
			return e
		}
	}
	if !found {
		return errors.New("client not found")
	}
	return nil
}
func (o *OAuth) Authenticate(token string) (Principal, error) {
	key := Hash(token)
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.authenticateKey(key)
}

type Denied struct{ Reason string }

func (e Denied) Error() string { return "authorization denied: " + e.Reason }
func (e Denied) Unwrap() error { return ErrUnauthorized }
func (o *OAuth) checkKey(key string) (credential, error) {
	g, ok := o.db.Access[key]
	if !ok {
		return g, Denied{"auth"}
	}
	if o.closed || o.clientRevoked(g.Client) || o.db.Revoked[g.Family] {
		return g, Denied{"revoked"}
	}
	if !o.now().Before(g.Expires) || !g.SessionExpires.IsZero() && !o.now().Before(g.SessionExpires) {
		return g, Denied{"expired"}
	}
	if g.Resource != o.issuer+"/mcp" {
		return g, Denied{"auth"}
	}
	if g.Scope != o.currentScope() {
		return g, Denied{"mode"}
	}
	return g, nil
}
func (o *OAuth) authenticateKey(key string) (Principal, error) {
	g, e := o.checkKey(key)
	if e != nil {
		return Principal{}, e
	}
	c := o.db.Clients[g.Client]
	now := o.now().UTC()
	if now.Sub(c.LastActivity) > time.Second {
		c.LastActivity = now
		o.db.Clients[g.Client] = c
		if e := o.save(); e != nil {
			return Principal{}, e
		}
	}
	p := Principal{ID: g.Client, Name: c.Name, Session: g.Family, Scope: g.Scope, Origin: o.issuer, Expires: g.Expires, Authenticated: true}
	p.Check = func() error { o.mu.Lock(); defer o.mu.Unlock(); _, e := o.checkKey(key); return e }
	return p, nil
}

// Invalidate is used for canonical-origin rotation. Registrations/history are
// retained, while all origin-bound credentials and incomplete ceremonies revoke.
func (o *OAuth) Invalidate() error {
	o.mu.Lock()
	o.closed = true
	if o.cancel != nil {
		o.cancel()
	}
	o.db.Access = map[string]credential{}
	o.db.Refresh = map[string]credential{}
	o.db.Pending = map[string]pending{}
	o.db.Codes = map[string]grant{}
	for id, c := range o.db.Clients {
		c.Expires = o.now().UTC()
		o.db.Clients[id] = c
	}
	e := o.save()
	o.mu.Unlock()
	o.workers.Wait()
	return e
}
