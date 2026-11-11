package tunnel

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestOwnedFakeTunnel(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cloudflared")
	os.WriteFile(p, []byte("#!/bin/sh\necho 'https://safe-test-name.trycloudflare.com' >&2\nexec sleep 30\n"), 0700)
	tt, e := Start(context.Background(), p, "http://127.0.0.1:1234")
	if e != nil {
		t.Fatal(e)
	}
	if tt.URL != "https://safe-test-name.trycloudflare.com" {
		t.Fatal(tt.URL)
	}
	tt.Close()
	tt.Close()
	if ParseURL("https://evil.trycloudflare.com.evil.example") != "" {
		t.Fatal("hostname suffix accepted")
	}
}
