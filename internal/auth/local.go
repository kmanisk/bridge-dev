package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"os"
	"path/filepath"
	"strings"
)

type principalKey struct{}

func WithClient(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, principalKey{}, id)
}
func Client(ctx context.Context) string {
	if v, ok := ctx.Value(principalKey{}).(string); ok {
		return v
	}
	return "stdio-local"
}
func Random() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func Hash(s string) string {
	v := sha256.Sum256([]byte(s))
	return base64.RawURLEncoding.EncodeToString(v[:])
}
func Equal(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func LocalToken(state string) (string, error) {
	if e := platform.PrivateDir(state); e != nil {
		return "", e
	}
	unlock, e := platform.Lock(filepath.Join(state, "token.lock"))
	if e != nil {
		return "", e
	}
	defer unlock()
	p := filepath.Join(state, "token")
	s, e := os.Lstat(p)
	if e == nil {
		if !s.Mode().IsRegular() || s.Mode().Perm() != 0600 {
			return "", errors.New("token file must be regular and mode 0600")
		}
		b, e := os.ReadFile(p)
		if e != nil {
			return "", e
		}
		token := strings.TrimSpace(string(b))
		if b, e := base64.RawURLEncoding.DecodeString(token); e != nil || len(b) != 32 {
			return "", errors.New("invalid stored token")
		}
		return token, nil
	}
	if !os.IsNotExist(e) {
		return "", e
	}
	token := Random()
	if e = platform.Atomic(p, []byte(token+"\n")); e != nil {
		return "", e
	}
	return token, nil
}
