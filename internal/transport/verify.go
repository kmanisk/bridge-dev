package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

var bearerSecretPattern = regexp.MustCompile(`(?i)(bearer\s+)[a-zA-Z0-9_\-\.]{8,}`)

func sanitizeError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	msg = bearerSecretPattern.ReplaceAllString(msg, "${1}[REDACTED]")
	return msg
}

type VerificationError struct {
	Stage                string
	PublicHostname       string
	LocalPort            int
	Elapsed              time.Duration
	HTTPStatus           int
	NetworkErrorCategory string
	CloudflaredState     string
	Err                  error
}

func (ve *VerificationError) Error() string {
	var b strings.Builder
	b.WriteString("endpoint verification failed:\n")
	fmt.Fprintf(&b, "  Stage: %s\n", ve.Stage)
	fmt.Fprintf(&b, "  Public hostname: %s\n", ve.PublicHostname)
	fmt.Fprintf(&b, "  Local port: %d\n", ve.LocalPort)
	fmt.Fprintf(&b, "  Elapsed: %s\n", ve.Elapsed.Round(time.Millisecond))
	if ve.HTTPStatus > 0 {
		fmt.Fprintf(&b, "  HTTP status, if any: %d\n", ve.HTTPStatus)
	} else {
		b.WriteString("  HTTP status, if any: none\n")
	}
	fmt.Fprintf(&b, "  Network error category: %s\n", ve.NetworkErrorCategory)
	fmt.Fprintf(&b, "  Cloudflared state: %s\n", ve.CloudflaredState)
	errMsg := ""
	if ve.Err != nil {
		errMsg = sanitizeError(ve.Err)
	}
	fmt.Fprintf(&b, "  Sanitized error: %s", errMsg)
	return b.String()
}

func (ve *VerificationError) Unwrap() error {
	return ve.Err
}

type CheckResult struct {
	Stage      string
	HTTPStatus int
	Category   string
	Err        error
}

func (cr *CheckResult) Error() string {
	if cr.Err != nil {
		return cr.Err.Error()
	}
	return cr.Category
}

func ClassifyError(err error, resp *http.Response) (string, int, string) {
	if resp != nil {
		status := resp.StatusCode
		switch status {
		case 1033:
			return "HTTP 1033", status, "Cloudflare tunnel error (HTTP 1033): edge cannot locate tunnel connection"
		case 502:
			return "HTTP 502", status, "bad gateway (HTTP 502): tunnel cannot reach origin server"
		case 401, 403:
			return "HTTP 401/403", status, fmt.Sprintf("HTTP %d: authorization or host validation rejected request", status)
		case 404:
			return "HTTP 404", status, fmt.Sprintf("HTTP %d: endpoint not found", status)
		case 429:
			return "HTTP 429", status, fmt.Sprintf("HTTP %d: request rate limited", status)
		default:
			if status >= 500 {
				return "HTTP 5xx", status, fmt.Sprintf("HTTP %d: upstream server error", status)
			}
			return fmt.Sprintf("HTTP %d", status), status, fmt.Sprintf("unexpected status code %d", status)
		}
	}
	if err == nil {
		return "none", 0, ""
	}
	san := sanitizeError(err)
	if strings.Contains(err.Error(), "1033") {
		return "HTTP 1033", 1033, "Cloudflare tunnel error (HTTP 1033): edge cannot locate tunnel connection"
	}
	if strings.Contains(err.Error(), "502") || strings.Contains(err.Error(), "bad gateway") {
		return "HTTP 502", 502, "bad gateway (HTTP 502): tunnel cannot reach origin server"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) || strings.Contains(err.Error(), "no such host") || strings.Contains(err.Error(), "server misbehaving") || strings.Contains(err.Error(), "temporary failure in name resolution") || (strings.Contains(err.Error(), "i/o timeout") && strings.Contains(err.Error(), "lookup")) {
		return "DNS failure", 0, san
	}
	if strings.Contains(err.Error(), "tls:") || strings.Contains(err.Error(), "certificate") || strings.Contains(err.Error(), "handshake failure") {
		return "TLS failure", 0, san
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) || strings.Contains(err.Error(), "Client.Timeout") || strings.Contains(err.Error(), "context deadline exceeded") {
		return "Timeout", 0, san
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) || strings.Contains(err.Error(), "connection refused") || strings.Contains(err.Error(), "connection reset") || strings.Contains(err.Error(), "broken pipe") || strings.Contains(err.Error(), "network is unreachable") {
		return "TCP failure", 0, san
	}
	return "TCP failure", 0, san
}

func VerificationClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func VerifyEndpoint(ctx context.Context, client *http.Client, origin string) error {
	res := VerifyEndpointWithInstance(ctx, client, origin, "", "")
	if res == nil {
		return nil
	}
	return res.Err
}

func VerifyEndpointWithInstance(ctx context.Context, client *http.Client, origin, expectedInstance, expectedMode string) *CheckResult {
	// 1. Healthz check
	r, e := http.NewRequestWithContext(ctx, "GET", origin+"/healthz", nil)
	if e != nil {
		return &CheckResult{Stage: "endpoint_health", Category: "Local server failure", Err: e}
	}
	resp, e := client.Do(r)
	if e != nil {
		cat, status, san := ClassifyError(e, nil)
		stage := "connectivity"
		if cat == "DNS failure" {
			stage = "dns"
		}
		return &CheckResult{Stage: stage, HTTPStatus: status, Category: cat, Err: errors.New(san)}
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	if resp.StatusCode != 200 {
		cat, status, san := ClassifyError(nil, resp)
		return &CheckResult{Stage: "endpoint_health", HTTPStatus: status, Category: cat, Err: errors.New(san)}
	}
	if readErr != nil {
		return &CheckResult{Stage: "endpoint_health", HTTPStatus: 200, Category: "TCP failure", Err: readErr}
	}
	if expectedInstance != "" {
		inst := resp.Header.Get("X-Bridge-Instance")
		if inst != "" && inst != expectedInstance {
			return &CheckResult{Stage: "instance_match", HTTPStatus: 200, Category: "Metadata/origin mismatch", Err: errors.New("health response does not match running Bridge instance")}
		}
	}
	if !strings.HasPrefix(string(body), "ok mode=") {
		return &CheckResult{Stage: "endpoint_health", HTTPStatus: 200, Category: "Metadata/origin mismatch", Err: errors.New("health response body invalid")}
	}
	if expectedMode != "" && !strings.Contains(string(body), "ok mode="+expectedMode) {
		return &CheckResult{Stage: "endpoint_health", HTTPStatus: 200, Category: "Metadata/origin mismatch", Err: fmt.Errorf("health mode mismatch: expected %s", expectedMode)}
	}

	// 2. OAuth authorization server metadata
	r, e = http.NewRequestWithContext(ctx, "GET", origin+"/.well-known/oauth-authorization-server", nil)
	if e != nil {
		return &CheckResult{Stage: "oauth_metadata", Category: "Local server failure", Err: e}
	}
	resp, e = client.Do(r)
	if e != nil {
		cat, status, san := ClassifyError(e, nil)
		return &CheckResult{Stage: "oauth_metadata", HTTPStatus: status, Category: cat, Err: errors.New(san)}
	}
	if resp.StatusCode != 200 {
		cat, status, san := ClassifyError(nil, resp)
		resp.Body.Close()
		return &CheckResult{Stage: "oauth_metadata", HTTPStatus: status, Category: cat, Err: errors.New(san)}
	}
	var as struct {
		Issuer    string `json:"issuer"`
		Authorize string `json:"authorization_endpoint"`
		Token     string `json:"token_endpoint"`
	}
	decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&as)
	resp.Body.Close()
	if decodeErr != nil {
		return &CheckResult{Stage: "oauth_metadata", HTTPStatus: 200, Category: "Metadata/origin mismatch", Err: decodeErr}
	}
	if as.Issuer != origin || as.Authorize != origin+"/authorize" || as.Token != origin+"/token" {
		return &CheckResult{Stage: "oauth_metadata", HTTPStatus: 200, Category: "Metadata/origin mismatch", Err: errors.New("authorization metadata origin mismatch")}
	}

	// 3. OAuth protected resource metadata
	r, e = http.NewRequestWithContext(ctx, "GET", origin+"/.well-known/oauth-protected-resource/mcp", nil)
	if e != nil {
		return &CheckResult{Stage: "resource_metadata", Category: "Local server failure", Err: e}
	}
	resp, e = client.Do(r)
	if e != nil {
		cat, status, san := ClassifyError(e, nil)
		return &CheckResult{Stage: "resource_metadata", HTTPStatus: status, Category: cat, Err: errors.New(san)}
	}
	if resp.StatusCode != 200 {
		cat, status, san := ClassifyError(nil, resp)
		resp.Body.Close()
		return &CheckResult{Stage: "resource_metadata", HTTPStatus: status, Category: cat, Err: errors.New(san)}
	}
	var pr struct {
		Resource string   `json:"resource"`
		Servers  []string `json:"authorization_servers"`
	}
	decodeErr = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&pr)
	resp.Body.Close()
	if decodeErr != nil {
		return &CheckResult{Stage: "resource_metadata", HTTPStatus: 200, Category: "Metadata/origin mismatch", Err: decodeErr}
	}
	if pr.Resource != origin+"/mcp" || len(pr.Servers) != 1 || pr.Servers[0] != origin {
		return &CheckResult{Stage: "resource_metadata", HTTPStatus: 200, Category: "Metadata/origin mismatch", Err: errors.New("resource metadata origin mismatch")}
	}

	// 4. Unauthenticated MCP challenge
	req, _ := http.NewRequestWithContext(ctx, "POST", origin+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, e = client.Do(req)
	if e != nil {
		cat, status, san := ClassifyError(e, nil)
		return &CheckResult{Stage: "mcp_challenge", HTTPStatus: status, Category: cat, Err: errors.New(san)}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 || !strings.Contains(resp.Header.Get("WWW-Authenticate"), origin+"/.well-known/oauth-protected-resource") {
		return &CheckResult{Stage: "mcp_challenge", HTTPStatus: resp.StatusCode, Category: "Metadata/origin mismatch", Err: errors.New("MCP authentication challenge verification failed")}
	}

	return nil
}
