# Development specification and boundaries

This project implements the user's M1-M7 development milestones with temporary
identity bridge-dev / github.com/kmanisk/bridge-dev / Bridge Development.

Required boundaries: local-only changes; no commit/push/publication/deployment,
no installed persistent service or automatic startup, no unsolicited public
tunnel, no changes to kmanisk/dots or existing user Codex configuration. The
project root is isolated under Projects. Product identity belongs in
internal/identity; dependency imports and command-directory names are mechanical
rename points.

Functional scope: official Go SDK stdio and authenticated stateless JSON
Streamable HTTP; readonly/user/local sudo/local dangerous registry construction;
allowed-root filesystem operations with race-resistant traversal; bounded argv
execution; metadata auditing; systemd and detached durable tasks; incremental
logs, stop/restart/forget, durable result recovery and per-client completion
acknowledgments; local bearer and OAuth authorization-code/S256 flows; explicitly
requested cloudflared lifecycle; user-facing CLI and comprehensive local tests.

Security invariants: fail closed on mode/config/auth errors; no anonymous MCP
operations, no remote privileged modes, no password collection or real privileged
tests, no raw access/refresh/client-secret persistence, no stdout diagnostics in
stdio, no stale PID signaling, no arbitrary external symlink traversal, and no
test operations on real user data. Command execution is explicitly not an OS
sandbox. Supported operation limits and residual platform/client constraints are
in SECURITY.md and THREAT_MODEL.md.

Validation contract: go fmt, go vet, go test, race tests (including race-built
server subprocesses), staticcheck, path fuzzing, actual SDK clients against built
stdio/HTTP binaries, Go 1.25 minimum build checks and four CGO-free cross-builds.
A complete implementation report distinguishes these from unverified native
platform and web-account behavior. No final product/repository name is chosen.

M5 starts with a four-tool ChatGPT compatibility probe. Codex stdio is the
primary local target; Claude Pro/Max is the primary web target. ChatGPT Plus
write capability is unknown until the account-specific manual probe runs and
must not gate the rest of the implementation. Exact manual steps and required
observation fields are in MANUAL_TEST.md.
