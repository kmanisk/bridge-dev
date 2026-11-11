package transport

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClassifyError(t *testing.T) {
	// DNS error
	dnsErr := &net.DNSError{Err: "no such host", Name: "xyz.trycloudflare.com"}
	cat, status, san := ClassifyError(dnsErr, nil)
	if cat != "DNS failure" || status != 0 || !strings.Contains(san, "no such host") {
		t.Fatalf("unexpected DNS classification: cat=%s status=%d san=%s", cat, status, san)
	}

	// TLS error
	tlsErr := errors.New("tls: handshake failure: remote error")
	cat, status, _ = ClassifyError(tlsErr, nil)
	if cat != "TLS failure" || status != 0 {
		t.Fatalf("unexpected TLS classification: cat=%s status=%d", cat, status)
	}

	// TCP error
	opErr := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
	cat, status, _ = ClassifyError(opErr, nil)
	if cat != "TCP failure" || status != 0 {
		t.Fatalf("unexpected TCP classification: cat=%s status=%d", cat, status)
	}

	// Timeout
	timeoutErr := context.DeadlineExceeded
	cat, status, _ = ClassifyError(timeoutErr, nil)
	if cat != "Timeout" || status != 0 {
		t.Fatalf("unexpected Timeout classification: cat=%s status=%d", cat, status)
	}

	// HTTP 1033 (Requirement F)
	resp1033 := &http.Response{StatusCode: 1033}
	cat, status, _ = ClassifyError(nil, resp1033)
	if cat != "HTTP 1033" || status != 1033 {
		t.Fatalf("unexpected 1033 classification: cat=%s status=%d", cat, status)
	}

	// HTTP 502
	resp502 := &http.Response{StatusCode: 502}
	cat, status, _ = ClassifyError(nil, resp502)
	if cat != "HTTP 502" || status != 502 {
		t.Fatalf("unexpected 502 classification: cat=%s status=%d", cat, status)
	}

	// HTTP 401 / 403 (Requirement G)
	resp403 := &http.Response{StatusCode: 403}
	cat, status, _ = ClassifyError(nil, resp403)
	if cat != "HTTP 401/403" || status != 403 {
		t.Fatalf("unexpected 403 classification: cat=%s status=%d", cat, status)
	}

	resp401 := &http.Response{StatusCode: 401}
	cat, status, _ = ClassifyError(nil, resp401)
	if cat != "HTTP 401/403" || status != 401 {
		t.Fatalf("unexpected 401 classification: cat=%s status=%d", cat, status)
	}

	// HTTP 429
	resp429 := &http.Response{StatusCode: 429}
	cat, status, _ = ClassifyError(nil, resp429)
	if cat != "HTTP 429" || status != 429 {
		t.Fatalf("unexpected 429 classification: cat=%s status=%d", cat, status)
	}
}

func TestVerificationErrorFormat(t *testing.T) {
	ve := &VerificationError{
		Stage:                "dns",
		PublicHostname:       "test-123.trycloudflare.com",
		LocalPort:            8765,
		Elapsed:              1234 * time.Millisecond,
		HTTPStatus:           1033,
		NetworkErrorCategory: "HTTP 1033",
		CloudflaredState:     "running",
		Err:                  errors.New("lookup failed with bearer secret-token-12345678"),
	}
	text := ve.Error()
	expectedFields := []string{
		"endpoint verification failed:",
		"Stage: dns",
		"Public hostname: test-123.trycloudflare.com",
		"Local port: 8765",
		"Elapsed: 1.234s",
		"HTTP status, if any: 1033",
		"Network error category: HTTP 1033",
		"Cloudflared state: running",
		"Sanitized error: lookup failed with bearer [REDACTED]",
	}
	for _, f := range expectedFields {
		if !strings.Contains(text, f) {
			t.Errorf("missing expected field %q in formatted error:\n%s", f, text)
		}
	}
	if strings.Contains(text, "secret-token") {
		t.Errorf("secret not sanitized: %s", text)
	}
}

func TestVerifyEndpointDetails(t *testing.T) {
	mux := http.NewServeMux()
	instanceID := "inst-456"
	origin := ""

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("X-Bridge-Instance", instanceID)
		w.Write([]byte("ok mode=readonly\n"))
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"issuer":"%s","authorization_endpoint":"%s/authorize","token_endpoint":"%s/token"}`, origin, origin, origin)
	})
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"resource":"%s/mcp","authorization_servers":["%s"]}`, origin, origin)
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, origin))
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()
	origin = srv.URL

	client := srv.Client()

	// 1. Success case
	res := VerifyEndpointWithInstance(context.Background(), client, origin, instanceID, "readonly")
	if res != nil {
		t.Fatalf("expected success, got: %v", res)
	}

	// 2. Instance mismatch case
	res = VerifyEndpointWithInstance(context.Background(), client, origin, "wrong-instance", "readonly")
	if res == nil || res.Stage != "instance_match" || res.Category != "Metadata/origin mismatch" {
		t.Fatalf("expected instance mismatch, got: %v", res)
	}

	// 3. Mode mismatch case
	res = VerifyEndpointWithInstance(context.Background(), client, origin, instanceID, "sudo")
	if res == nil || res.Stage != "endpoint_health" || res.Category != "Metadata/origin mismatch" {
		t.Fatalf("expected mode mismatch, got: %v", res)
	}

	// 4. HTTP 1033 classification (Requirement F)
	// Go's net/http.Server rejects status codes > 999, so use raw TCP listener to simulate Cloudflare edge.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 1024)
				_, _ = c.Read(buf)
				_, _ = c.Write([]byte("HTTP/1.1 1033 Argo Tunnel Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
			}(conn)
		}
	}()

	res = VerifyEndpointWithInstance(context.Background(), http.DefaultClient, "http://"+l.Addr().String(), instanceID, "readonly")
	if res == nil || res.HTTPStatus != 1033 || res.Category != "HTTP 1033" {
		t.Fatalf("expected HTTP 1033, got: %v", res)
	}

	// 5. HTTP 403 Host rejection (Requirement G)
	badMux2 := http.NewServeMux()
	badMux2.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "invalid host", http.StatusForbidden)
	})
	badSrv2 := httptest.NewServer(badMux2)
	defer badSrv2.Close()

	res = VerifyEndpointWithInstance(context.Background(), badSrv2.Client(), badSrv2.URL, instanceID, "readonly")
	if res == nil || res.HTTPStatus != 403 || res.Category != "HTTP 401/403" {
		t.Fatalf("expected HTTP 401/403, got: %v", res)
	}
}

func TestLocalReadySuccessAndFailure(t *testing.T) {
	// Local server ready (Requirement A)
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("X-Bridge-Instance", "inst-1")
		w.Write([]byte("ok mode=readonly\n"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	if err := checkLocalReady(context.Background(), srv.URL, "inst-1"); err != nil {
		t.Fatalf("expected local ready, got: %v", err)
	}

	// Instance mismatch
	ctxMismatch, cancelMismatch := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancelMismatch()
	if err := checkLocalReady(ctxMismatch, srv.URL, "wrong-inst"); err == nil {
		t.Fatal("expected failure on wrong instance, got nil")
	}

	// Server not running
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := checkLocalReady(ctx, "http://127.0.0.1:59999", "inst-1"); err == nil {
		t.Fatal("expected failure on closed port, got nil")
	}
}
