package auth

import (
	"context"
	"errors"
	"time"
)

type Principal struct {
	ID            string
	Name          string
	Session       string
	Scope         string
	Origin        string
	CallDeadline  time.Time
	Expires       time.Time
	Authenticated bool
	Check         func() error
}
type principalDataKey struct{}

func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(WithClient(ctx, p.ID), principalDataKey{}, p)
}
func Identity(ctx context.Context) Principal {
	if p, ok := ctx.Value(principalDataKey{}).(Principal); ok {
		return p
	}
	return Principal{ID: Client(ctx), Session: "stdio-local", Scope: "local", Check: func() error { return nil }}
}

var ErrUnauthorized = errors.New("authorization expired or revoked")
