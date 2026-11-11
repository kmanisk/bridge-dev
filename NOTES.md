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

## M9 - verified one-command startup foundation

connect now runs doctor checks, asks a serialized terminal wizard on first use or
reconfigure, saves preferences privately, reapplies flag/env precedence, starts
loopback HTTP then the owned tunnel, establishes a canonical origin, verifies
health/discovery/challenge before readiness, attempts clipboard copy and prints
web-client instructions. Custom argv templates and explicit HTTPS origins are
supported. No shell parsing of tunnel commands. Basic foreground events identify
authenticated clients separately from self-reported names, first calls, denials,
task completions and approaching idle exit. Background monitors join on shutdown.

The shared Prompter coordinator was implemented here as an M10 dependency. OAuth
terminal consent, ongoing tunnel restart and privileged connect authorization
remain assigned to M10/M12/M14; no premature claim is made for those paths.
Tests use scripted answers, fake clipboard/cloudflared and a loopback-only proxy
that verifies public advertised metadata never contains 127.0.0.1/localhost.
make check, fuzz (1,090,142 cases) and all four release builds passed. No public
tunnel or real clipboard/client change was made during tests.

## M10 - verified terminal consent and application sessions

Default runtime OAuth now requires terminal confirmation through the shared
coordinator. Browser pages show a cryptographically generated six-digit match
code and poll without granting approval themselves. One active consent prompt,
independent queued requests, 60-second expiry, repeated-request rate limits,
CSRF/cookie protection and exact redirect URI plus configurable host checks are
implemented. --auth code preserves the original pairing flow; its integration
fixture explicitly selects that mode and a temporary loopback redirect host.

Added private persistent client metadata, fixed application-session expiry,
refresh rotation and CLI clients list/revoke/revoke-all. Revocation markers are
independent atomic files so the running server observes CLI revocation on every
authorization use without overwriting concurrent token state. Principals include
resource/scope/session/expiry and a revalidation callback. Origin invalidation
revokes cached principals and credentials; mode changes preserve registrations,
back up state and clear stale credentials instead of promoting old tokens.

M10 make check, path fuzz and four release builds passed. Scripted tests cover
consent approval/denial/timeout/rate-limit, queued HTTP responses, serialization,
headless refusal, redirects, client revocation, session identity, mode/origin
invalidation and retained legacy PKCE/refresh/revocation. No real web account,
TTY password or public tunnel was involved. CIMD is optional and deferred.

## M11 - approvals and durable dispatch

Added per-client authorization-session approvals, a single prompt coordinator,
120-second denial timeout, yes/no/class-session responses, and private random
pending IDs. MCP approval_status and task_wait accept bounded polling. HTTP
operation waits are capped at 24 seconds, with a 25-second response ceiling;
long work returns a pending result rather than a false success. Headless gated
operations deny. Every dispatch revalidates the principal after the prompt.

Mutating operations now require request_key: one stable unique key per logical
operation, reused only for retries. This explicit protocol requirement replaces
Phase 1's unconditional repeated dispatch. A changed operation under an existing
key is rejected. Atomic private records precede dispatch; crashed dispatches
report unknown and are never rerun automatically. This is at-most-once automatic
dispatch, not exactly-once execution. Results are retrievable only by the same
client/application session/scope/origin. A fresh key permits an intentional repeat.

Audit intent now uses pending, with requested/resolved paths, operation category,
approval transitions and denial reasons. Command arguments, contents, auth tokens
and terminal codes are excluded. Host-header rejection logging is rate limited.
Direct tests cover approvals, timeout/headless, retries, session isolation,
revocation before execution, audit failure and subprocess crash boundaries.

## M12 - effective privileged sessions and noninteractive execution

Replaced the categorical remote privilege ban with OAuth plus current startup
authorization. Saved sudo/dangerous preferences require a typed startup phrase;
only manually set ack_privileged=true bypasses it. The wizard never sets that
value. Foreground startup attaches sudo -v directly to the controlling terminal.
A cold foreground sudo cache can request renewed validation through the same
coordinator; every queued operation is revalidated afterward. Detached/headless
operation never prompts or reads a password. Actual commands always use sudo -n.
Sudo defaults to unrestricted argv; explicit sudo_commands is optional. Dangerous
bypasses command allow/deny policy and roots, with optional explicit shell tool.

Timed grants downgrade to the preceding safe configured mode (readonly when no
preceding safe mode exists), remove stale tools, and deny queued privileged work.
Already-running tasks continue. The fallback uses separate safe roots, never the
dangerous full-filesystem handle. Health reports only mode and basic health.

Privileged background tasks launch sudo -n systemd-run system units with a worker
running as the original user. The worker must independently authorize its actual
sudo -n command, typically through deliberately scoped NOPASSWD rules; terminal
credential caches are not assumed transferable. Failed authorization is a durable
failed task, with a clear worker diagnostic. This preserves user-owned state and
avoids executing a root worker from mutable user metadata. Root task execution
requires explicit authorization in both launcher and worker contexts.

Added preview/confirmed sudoers install with immutable-preview digest verification,
visudo -cf validation of the exact snapshot, atomic read-only installation, and
refusal to overwrite an existing rule. Default previews contain only no-argument
rules; broad executables receive warnings. No rule installs automatically.

up --detach snapshots private configuration and starts a transient systemd user
unit, never enabling it. Required terminal approvals deny; ordinary approve=none
calls remain usable. Pairing-code mode is refused detached to avoid journal secret
exposure. Tests cover phrases/manual ack, OAuth gating, timed/queued expiry,
registry changes, cold sudo contexts, system-unit argv, detached launch and rule
snapshot validation using temporary fake executables only.

## M13 - safe local client registration

Added install/uninstall codex and claude-code using documented native user-scope
commands, absolute Bridge paths, explicit roots/mode and private policy snapshots.
A terminal confirmation precedes configuration mutation. Ownership receipts bind
the complete installed entry; changed or unrelated registrations are never removed.
Print-only previews do not write snapshots, receipts or client files. Desktop
prints a mergeable documented JSON snippet rather than guessing Linux GUI paths;
its manual entries require manual removal. Existing stdio and the four-tool web
probe remain intact. docs/LOCAL_CLIENTS.md records source/API verification.

Tests use temporary fake Codex/Claude executables and configuration files, cover
denial/yes/idempotency/modified-entry refusal/uninstall and clipboard-independent
print behavior. Installed Codex 0.167.1 was also exercised with isolated temporary
CODEX_HOME for actual add/get/remove. No real workstation client config changed.

## M14 - recovery, visibility and bounded file interaction

Added owned process-group tunnel cleanup and restart with capped exponential
backoff, repeated reachability checks, verified new URLs, origin credential
invalidation and privileged-grant revocation. The positive privileged OAuth
rotation test exposed and removed an additional Phase 1 OAuth-constructor ban
missed by M12's negative-policy tests. Built-server tests now complete OAuth in
sudo mode and invoke only a deliberately failing fake sudo; remote privileged
success is no longer inferred solely from tool registration. Privileged token and
refresh expiry are clipped to timed grants; metadata scopes track effective mode.

status uses a local authenticated administration endpoint, reports effective mode,
clients/last activity, tasks, idle/grant deadlines and last ten audit lines. A
second owned runtime record recovers missing http.json; stale PIDs are never
signalled. Missing state is stopped; undiscoverable locked state is explicitly
partial and refuses unsafe shutdown. Added watch with rotation-aware audit tail.

Named tunnel setup delegates login/create/DNS to native cloudflared after explicit
confirmation and can return to account-free quick mode. Custom argv templates use
an explicit verified HTTPS origin, without a shell. docs/TUNNELS.md explains trust
and hostname rotation. No public tunnel/account/DNS operation ran in tests.

Adopted Desktop Commander design lessons as idiomatic Go: file byte slices with
next offsets and binary encoding; directory and filename/content search pages
with continuation/incomplete/skipped metadata. Existing default whole-file and
filename-list results remain compatible. Cursors are offsets, not snapshots;
concurrent directory changes may change ordering. Exact atomic editing remains.
Technical byte/output/task-log/search/depth/timeout/concurrency/auth-state bounds
are configurable, including explicit dangerous-only unlimited meaningful bounds.
The HTTP polling limit remains fixed at 25 seconds. These are resource/abuse
bounds, never billing or monthly tool-call quotas. Actual task dispatch now also
audits from the independent worker before starting a command.

Regression tests cover fake tunnel rotation and actual terminal-consent OAuth
credentials, safe partial state/down, named/quick setup, slices/content pages,
configured/unlimited output, worker context failures and ambiguous result storage.
