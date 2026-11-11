GO ?= go
BINARY := bridge-dev
STATICCHECK := .tools/staticcheck

.PHONY: build test check race fuzz staticcheck cross clean
build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags='-s -w' -o bin/$(BINARY) ./cmd/bridge-dev

test:
	$(GO) test -count=1 ./...

race:
	$(GO) test -race -count=1 ./...

staticcheck:
	$(STATICCHECK) ./...

fuzz:
	$(GO) test ./internal/fsjail -run='^$$' -fuzz=FuzzPaths -fuzztime=10s -parallel=2

check:
	$(GO) fmt ./...
	$(GO) vet ./...
	$(GO) test -count=1 ./...
	$(GO) test -race -count=1 ./...
	$(STATICCHECK) ./...

cross:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags='-s -w' -o bin/$(BINARY)-linux-amd64 ./cmd/bridge-dev
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build -trimpath -ldflags='-s -w' -o bin/$(BINARY)-linux-arm64 ./cmd/bridge-dev
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 $(GO) build -trimpath -ldflags='-s -w' -o bin/$(BINARY)-darwin-amd64 ./cmd/bridge-dev
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 $(GO) build -trimpath -ldflags='-s -w' -o bin/$(BINARY)-darwin-arm64 ./cmd/bridge-dev

clean:
	rm -f bin/$(BINARY) bin/$(BINARY)-linux-amd64 bin/$(BINARY)-linux-arm64 bin/$(BINARY)-darwin-amd64 bin/$(BINARY)-darwin-arm64
