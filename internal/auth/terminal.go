package auth

import (
	"context"
	"crypto/rand"
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"html/template"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var terminalTemplate = template.Must(template.New("terminal").Parse(`<!doctype html><html><head><title>{{.Name}} authorization</title></head><body><h1>Confirm in the local Bridge terminal</h1><p>Client: {{.Client}}</p><p>Verification code: <strong>{{.Code}}</strong></p><p>Status: {{.Status}}</p><p>Only the computer owner can approve this request in the terminal. This page cannot grant access.</p><form method="POST" action="/authorize"><input type="hidden" name="request_id" value="{{.ID}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><button>Check authorization</button></form><script nonce="{{.Nonce}}">setTimeout(function(){document.forms[0].submit()},1500)</script></body></html>`))

type rateWindow struct {
	start time.Time
	count int
}

func (o *OAuth) ConfigureTerminal(ctx context.Context, p *prompt.Coordinator, hosts []string) {
	o.terminal = true
	o.prompt = p
	o.redirectHosts = append([]string{}, hosts...)
	o.ctx, o.cancel = context.WithCancel(ctx)
	o.codes = map[string]string{}
	o.rates = map[string]rateWindow{}
	o.consentGate = make(chan struct{}, 1)
	o.consentTTL = time.Minute
	o.rateLimit = 5
	o.ratePeriod = time.Minute
}
func (o *OAuth) Close() {
	o.mu.Lock()
	o.closed = true
	if o.cancel != nil {
		o.cancel()
	}
	o.mu.Unlock()
	o.workers.Wait()
}
func (o *OAuth) allowedRedirect(s string) bool {
	if o.redirectHosts == nil {
		return true
	}
	u, e := url.Parse(s)
	if e != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, allowed := range o.redirectHosts {
		if host == strings.ToLower(allowed) {
			return true
		}
	}
	return false
}
func (o *OAuth) terminalPage(w http.ResponseWriter, id, csrf string, p pending) {
	nonce := Random()
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+nonce+"'; form-action 'self'; frame-ancestors 'none'")
	// no-referrer makes navigation form POSTs serialize Origin as null.
	// same-origin retains a verifiable same-origin Origin while suppressing
	// referrers to external callbacks. Never relax the POST origin guard.
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = terminalTemplate.Execute(w, struct{ Name, Client, Code, Status, ID, CSRF, Nonce string }{identity.Name, o.db.Clients[p.Client].Name, o.codes[id], p.Status, id, csrf, nonce})
}
func (o *OAuth) beginTerminal(w http.ResponseWriter, r *http.Request, p pending, csrf, cookie string) {
	if o.prompt == nil || !o.prompt.Available() {
		oauthError(w, 403, "interaction_required")
		return
	}
	now := o.now()
	rate := o.rates[p.Client]
	if now.Sub(rate.start) >= o.ratePeriod {
		rate = rateWindow{start: now}
	}
	rate.count++
	o.rates[p.Client] = rate
	if rate.count > o.rateLimit {
		oauthError(w, 429, "slow_down")
		return
	}
	if o.MaxPending > 0 && len(o.db.Pending) >= o.MaxPending {
		oauthError(w, 429, "slow_down")
		return
	}
	if o.OnConsent != nil {
		if e := o.OnConsent(p.Client, "requested"); e != nil {
			oauthError(w, 503, "temporarily_unavailable")
			return
		}
	}
	n, e := rand.Int(rand.Reader, big.NewInt(1000000))
	if e != nil {
		oauthError(w, 500, "server_error")
		return
	}
	id := Random()
	code := fmt.Sprintf("%06d", n.Int64())
	p.Status = "pending"
	p.Expires = now.Add(o.consentTTL)
	o.db.Pending[id] = p
	o.codes[id] = code
	if e = o.save(); e != nil {
		delete(o.db.Pending, id)
		delete(o.codes, id)
		oauthError(w, 500, "server_error")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: identity.Binary + "-consent-" + id, Value: cookie, Path: "/authorize", HttpOnly: true, Secure: strings.HasPrefix(o.issuer, "https:"), SameSite: http.SameSiteStrictMode, MaxAge: 60})
	o.terminalPage(w, id, csrf, p)
	o.workers.Add(1)
	go func() {
		defer o.workers.Done()
		ctx, cancel := context.WithTimeout(o.ctx, o.consentTTL)
		defer cancel()
		decision := "expired"
		select {
		case o.consentGate <- struct{}{}:
			defer func() { <-o.consentGate }()
			u, _ := url.Parse(p.Redirect)
			answer, e := o.prompt.Ask(ctx, fmt.Sprintf("Approve client?\nClient (self-reported): %q\nClient ID: %s\nRedirect host: %s\nRequested mode: %s\nCode: %s\nApprove? [y/N] ", o.clientName(p.Client), p.Client, u.Hostname(), strings.TrimPrefix(p.Scope, "mcp:"), code))
			if e == nil {
				decision = "denied"
				if strings.EqualFold(strings.TrimSpace(answer), "y") {
					decision = "approved"
				}
			}
		case <-ctx.Done():
		}
		o.mu.Lock()
		defer o.mu.Unlock()
		if current, ok := o.db.Pending[id]; ok {
			if o.closed || !o.now().Before(current.Expires) || o.clientRevoked(current.Client) {
				decision = "expired"
			}
			if o.OnConsent != nil {
				if e := o.OnConsent(current.Client, decision); e != nil {
					decision = "denied"
				}
			}
			current.Status = decision
			o.db.Pending[id] = current
			_ = o.save()
		}
	}()
}
func (o *OAuth) clientName(id string) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.db.Clients[id].Name
}

func (o *OAuth) ConfigureCode(hosts []string) { o.redirectHosts = append([]string{}, hosts...) }
