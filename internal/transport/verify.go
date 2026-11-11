package transport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

func VerificationClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func VerifyEndpoint(ctx context.Context, client *http.Client, origin string) error {
	get := func(path string, dest any) error {
		r, e := http.NewRequestWithContext(ctx, "GET", origin+path, nil)
		if e != nil {
			return e
		}
		resp, e := client.Do(r)
		if e != nil {
			return errors.New("endpoint unreachable")
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return errors.New("endpoint health/metadata status not 200")
		}
		if dest != nil {
			return json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(dest)
		}
		return nil
	}
	if e := get("/healthz", nil); e != nil {
		return e
	}
	var as struct {
		Issuer    string `json:"issuer"`
		Authorize string `json:"authorization_endpoint"`
		Token     string `json:"token_endpoint"`
	}
	if e := get("/.well-known/oauth-authorization-server", &as); e != nil {
		return e
	}
	if as.Issuer != origin || as.Authorize != origin+"/authorize" || as.Token != origin+"/token" {
		return errors.New("authorization metadata origin mismatch")
	}
	var pr struct {
		Resource string   `json:"resource"`
		Servers  []string `json:"authorization_servers"`
	}
	if e := get("/.well-known/oauth-protected-resource/mcp", &pr); e != nil {
		return e
	}
	if pr.Resource != origin+"/mcp" || len(pr.Servers) != 1 || pr.Servers[0] != origin {
		return errors.New("resource metadata origin mismatch")
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", origin+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, e := client.Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 || !strings.Contains(resp.Header.Get("WWW-Authenticate"), origin+"/.well-known/oauth-protected-resource") {
		return errors.New("MCP authentication challenge verification failed")
	}
	return nil
}
