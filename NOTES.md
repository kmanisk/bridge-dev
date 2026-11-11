# Milestone record

## M1 foundation

Implemented isolated Go module, centralized identity, CLI configuration model,
strict TOML parsing, precedence (flags > environment > file > defaults), mode
validation and secure defaults. SDK pinned to stable v1.8.0. No Git repository
created. No workstation configuration changed.

Validation: first config/policy tests passed; full final validation is in TEST_REPORT.md. Missing/invalid explicit config fails closed.

## M1 validation

`go test ./internal/config ./internal/policy` passed. CLI and strict config are
integrated in the built binary. No existing project or user config overwritten.

## M2 stdio

Official SDK v1.8.0 integration, readonly filesystem tools, process names/PIDs,
search/fetch aliases, mode-specific registration and annotations implemented.
Built-binary SDK clients pass tools/list tests for readonly/user/sudo, reads and
user operations. Linux traversal/symlink/special-file/path-race tests pass.
No non-protocol stdout diagnostics. macOS implementation is isolated; runtime
validation remains unavailable on this Linux machine.

## M3 user mode

Atomic filesystem writes and exact-once edits, literal argv, cwd descriptors,
command allow/deny, clean environment, timeout, process groups, bounded output,
exit/signal result and locked/rotated metadata audit implemented. Separate sudo
allowlist and noninteractive argv; fake sudo tests only. No real sudo execution
or sudoers modification. Preview-only generation validates via visudo -cf.
Unit tests cover policy denial, no shell expansion, output truncation, exit 7,
timeout and fake sudo construction. Audit tests cover schema omission/rotation.

## M4 durable tasks

Independent workers, systemd transient user units with --collect, detached
fallback, private spec/status/logs, process identity, stop/wait/restart/forget,
log cursors and completion acknowledgment implemented. Built-binary tests prove
both backends survive MCP restart and persist exit 7 after systemd collection.
Stop and log continuation tests pass. Lost workers/reboot remain explicit unknown
outcomes, not invented completion. Live systemd resource metrics and independent monotonic completion
records are implemented and tested; total retained task disk is user-managed.

## M5 HTTP and first compatibility probe

First HTTP integration used the minimal four-tool ChatGPT probe: probe_read,
probe_write (harmless dummy), search/fetch. Built-binary SDK tests pass local
bearer authentication, discovery and calls, plus idle exit. Ordinary HTTP uses
the official stateless JSON transport. Host/Origin/size/concurrency/active-idle
and remote privilege-rejection tests pass. Private 256-bit token file and
minimal /healthz implemented. Startup tests initially rejected public temporary
state directories; fixtures were corrected to 0700 without weakening the server.

## M6 OAuth and tunnel orchestration

Authorization code/S256, exact redirects, metadata, public dynamic registration,
local one-time consent, cookie/CSRF/state, resource binding, access expiry,
refresh rotation/replay revocation, persistent hashes and revocation implemented.
Unit HTTP clients and an actual built-binary OAuth-to-MCP test pass. Authenticated
client identity reaches audits; revoked tokens fail. Confidential client_secret_basic and RFC 9207 issuer identification also
implemented and tested. No external identity provider or client ID metadata
documents supported.
Cloudflared child ownership/hostname parsing/cleanup tested using a fake local
executable. Real cloudflared is absent; no public tunnel launched. Claude/ChatGPT
account tests are manual, not claimed complete. Plan restrictions remain unknown.

## M7 local verification complete; manual client/platform checks outstanding

README, architecture, security, threat model, manual checklist, MIT license,
Makefile and local SDK test client added. Codex 0.167.0 isolated add/get/remove
passed, with a temporary-home PATH-alias warning; regular Codex config untouched.
No model API request made. Full checks, cross-build evidence and final residual
limits are recorded in TEST_REPORT.md. No commit/push/publish,
persistent service, workstation configuration edit or public exposure performed.


Final review added precise per-tool schemas, binary-safe filesystem content,
public/confidential client authentication, issuer identification, direct broker
guards, and test environment isolation. Normal and race-built actual servers
were tested; the race exit delay exposed and corrected a collection-test timing
assumption. Actual MCP crash survival and active-request idle protection pass.
Independent completion records persist through forget and clock rollback. No
real web/tunnel/privileged result is claimed. See TEST_REPORT.md for exact gates,
artifacts and manual limits.

A final failure-path test corrected incomplete task directories after backend
admission rejection. Failed launches retain explicit final metadata and an
initial log. Stale PID identities are tested to receive no stop request.

Final uncached normal/race suites, vet, staticcheck, Go 1.25 package checks and
all four release cross-builds passed after the task admission fix. Actual human
CLI status/down and task list/status/logs/stop also passed against an isolated
instance. Hash verification passed. No bridge process, transient unit or
persistent bridge unit file remains.

## Phase 2 M8 - verified foundation

Preserved the Phase 1 baseline and ran uncached normal/race/staticcheck before
changes. Initialized only a local main branch, without a remote. Renamed module
and imports to github.com/kmanisk/bridge-dev; identity.Name is the one product
name with Binary derived from it. Added strict schema-v2 preferences and atomic
0600 migration with reversible pre-v2 backups; runtime grants/acknowledgment are
not persisted. Loading a dangerous preference does not authorize execution.
Pinned Desktop Commander source/license review and decisions are documented in
docs/DESKTOP_COMMANDER_COMPARISON.md. No upstream code was copied or executed.
Intentional replacements are listed in docs/SUPERSEDED_RESTRICTIONS.md.
M8 make check, fuzz and all four CGO-free builds passed. Evidence under
test-output/m8-*. No real tunnel or sudo was launched.
