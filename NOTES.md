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

## M15 - final regression, coverage, Fish and synchronized documentation

Added direct identity/platform tests and expanded server/filesystem tests. Actual
server integration builds use go build -cover and private GOCOVERDIR, preserving
race-built subprocess validation. make coverage exports separate unit/subprocess
profiles: final statement totals are 64.7% and 43.6%. These are not a combined score;
TTY, native privileged/provider/platform and some failure paths remain uncovered.
A 27-second actual HTTP command returns a pending ID before 25 seconds, completes
through polling, and is not redispatched under its retried request key.

Added Fish completions without live installation, rewritten exact Fish manual and
a Go-only syntax checker for all 20 Fish blocks. Current official client docs were
reviewed; the current ChatGPT Plugins path and older account-specific Apps path
are both explained, DCR is selected, and no account/plan access is inferred.
Task status/log resource templates were added using verified SDK APIs; approve=all
omits alternate resources so they cannot bypass gated read tools. Initialization
names are recorded as self-reported, with direct SDK assertions.

Final review corrected safe-root descriptor cleanup, pre-launch authorization and
worker grant checks, Darwin device checks, concurrent no-replace sudoers install,
pruning of revoked/expired DCR registrations, audit pending/completion/auth reasons,
and public up URL output. Watch rotation has a direct regression test. Broad root
write/exec implications are documented explicitly; no OS sandbox claim is made.

Final make check (fmt/vet/uncached normal/race/staticcheck/Fish), make fuzz (979,426
executions), all four CGO-free cross-builds, host build and make coverage passed.
Linux artifacts are statically linked. No real sudo/public tunnel/native macOS or
real AI account was used. No project process or loaded user unit remained in the
final cleanup check. All intentional supersessions and remaining human evidence
are synchronized in REQUIREMENTS.md, TEST_REPORT.md and MANUAL_TEST.md. No mandatory
local implementation blocker remains. No remote, push, publication or permanent
service was created. Local M15 commit follows the verified source/doc review.

## Cloudflare connection diagnosis and readiness verification fix

### Root Cause
During `bridge-dev connect`, startup failed with `endpoint verification failed: endpoint unreachable`
after approximately 49 seconds. The failure occurred because:
1. `internal/tunnel/cloudflared.go` unblocked immediately upon parsing the trycloudflare.com URL from
   child output, prior to edge connection registration (`connIndex=0`) or DNS propagation.
2. `internal/transport/http.go` immediately initiated external verification without first confirming
   that the local HTTP listener responded to `/healthz`.
3. The verification loop queried the external endpoint in an aggressive 200ms tight loop without
   backoff. Early DNS queries for newly generated hostnames returned NXDOMAIN, which local resolvers
   (including systemd-resolved) cached for up to 60 seconds (the SOA minimum TTL).
4. `internal/transport/verify.go` discarded underlying Go errors, unconditionally returning a generic
   `endpoint unreachable`. In Go's standard HTTP client, Cloudflare edge status 1033 is parsed as a
   connection error (`malformed HTTP status code "1033"`), which was also collapsed into unreachable.
5. All subsequent stdout/stderr logs from the cloudflared child were discarded (`io.Discard`),
   hiding edge connection registration messages and exit diagnostics.
6. The verification loop failed to check whether the child process exited (`owned.Done()`), causing it
   to sit through the full 30-second deadline even if the child had failed.
7. `VerifyEndpoint` verified status codes but did not verify that the `/healthz` response belonged
   to the running Bridge instance (`X-Bridge-Instance`), allowing potential false positives from proxies.
8. Host header validation in `Handler.ServeHTTP` was case-sensitive and did not normalize default `:443`
   ports on incoming requests from external relays.

### Implementation Changes
1. Structured Readiness Pipeline: Implemented a 9-step readiness sequence:
   - Start local HTTP server and confirm local `/healthz` responsiveness via `checkLocalReady`.
   - Start cloudflared child with combined stdout/stderr capture into a thread-safe circular log buffer.
   - Detect tunnel state (`starting`, `url announced`, `registered connIndex=...`, `exited`).
   - Validate canonical HTTPS origin and bind handler before external checks.
   - Verify public endpoint readiness with exponential backoff (starting at `opt.RetryBase` or 200ms,
     doubling up to 2s) and 35-second overall deadline.
   - Fail fast if the tunnel child process exits prematurely (`activeTunnel.IsDone()`), reporting exit
     code and last log line without stalling for the deadline.
   - Confirm `/healthz` response contains the instance token (`X-Bridge-Instance`), `ok mode=` prefix,
     and expected mode.
2. Structured Diagnostic Error Reporting: Implemented `VerificationError` implementing `error` and `Unwrap()`,
   formatting failure reports with:
   - `Stage`: `local_http`, `tunnel_start`, `tunnel_process`, `dns`, `connectivity`, `endpoint_health`,
     `instance_match`, `oauth_metadata`, `resource_metadata`, `mcp_challenge`.
   - `Public hostname`: hostname under verification.
   - `Local port`: actual bound loopback TCP port.
   - `Elapsed`: elapsed duration rounded to milliseconds.
   - `HTTP status, if any`: HTTP status code or `none`.
   - `Network error category`: `DNS failure`, `TLS failure`, `TCP failure`, `Timeout`, `HTTP 1033`,
     `HTTP 502`, `HTTP 401/403`, `HTTP 404`, `HTTP 429`, `HTTP 5xx`, `Local server failure`,
     `Tunnel process failure`, `Metadata/origin mismatch`.
   - `Cloudflared state`: current runtime status and connection state.
   - `Sanitized error`: error message with authentication tokens and secrets redacted.
3. Host and Origin Normalization: Enhanced `matchHost` and `matchOrigin` with case-insensitivity and
   default port `:443` stripping for public HTTPS relays, while preserving strict loopback isolation
   for administration endpoints (`/_status`, `/_shutdown`).
4. Fail-Closed Security and Lifecycle Cleanup: Unauthenticated `/mcp` challenge remains strictly enforced;
   no internal IP or localhost leaks in OAuth metadata; durable tasks and client records are preserved
   on startup failure; only owned process groups are terminated.

### Verification
- `internal/transport/verify_test.go`: Tests error classification (DNS, TLS, TCP, timeout, 1033, 502, 401/403),
  `VerificationError` formatting, instance mismatch detection, mode mismatch detection, and local server readiness.
- `internal/transport/http_test.go`: `TestTrustedPublicHost` tests case-insensitive host matching, default
  port `:443` handling, untrusted host rejection, and loopback-only admin protection.
- `internal/tunnel/cloudflared_test.go`: Tests tunnel lifecycle, log capture, immediate process exit handling,
  and owned process group cleanup.
- `internal/connect/connect_test.go`: `TestTransientErrorsRecover` tests transient connection refused, DNS,
  and 502 errors; `TestRetryAfterFailureWorksWithoutStaleState` tests clean subsequent runs after failure;
  `TestDurableTasksSurviveTunnelFailure` tests task persistence; `TestNoDuplicateTunnelProcess` tests process ownership.
- `make check`, `make fuzz`, and staticcheck all pass.

## Public Quick Tunnel Resolution and Fallback DNS Fix

### Root Cause
1. Premature Verification: `cloudflared` Quick Tunnel prints the URL before edge connection registration
   (`INF Registered tunnel connection connIndex=0`).
2. Negative DNS Caching: Initiating DNS queries immediately causes the local stub resolver (`systemd-resolved`
   on `127.0.0.53:53`) to query upstream before Cloudflare DNS authoritative nameservers publish the ephemeral record.
   The upstream returns `NXDOMAIN`, which `systemd-resolved` caches for the SOA TTL (60s).
3. Insufficient Deadline: The previous 35-second verification deadline expired before the 60s negative cache entry
   TTL elapsed, causing every retry to fail with `no such host on 127.0.0.53:53`.

### Architecture and Fix
1. Edge Registration Synchronization:
   - `internal/tunnel/cloudflared.go`: Added `Registered() <-chan struct{}` and `WaitRegistered(ctx, timeout)` on `Tunnel`.
     `appendLog` detects `Registered tunnel connection` and `registered connIndex=` to close `t.registered`.
   - In `internal/transport/http.go`, `verify` calls `activeTunnel.WaitRegistered` before starting external HTTP requests.
2. Controlled Fallback DNS Resolver in Verification Client:
   - `internal/transport/verify.go`: Implemented `CheckDNS`, `CheckDNSWithResolvers`, and `VerificationClientWithResolver`.
   - Primary resolver (`net.DefaultResolver`) is queried first. If it returns a DNS error / `no such host`, `CheckDNS`
     falls back to querying trusted public resolvers (`1.1.1.1:53`, `8.8.8.8:53`, `1.0.0.1:53`).
   - Rebind Prevention & Validation: `IsValidPublicIP` and `FilterValidPublicIPs` reject loopback, RFC1918 private,
     multicast, unspecified, and link-local IP addresses for public hostnames.
   - TLS SNI & Host Preservation: `DialContext` connects via the validated IP, while Go's `http.Transport` strictly
     preserves TLS SNI (`ServerName: host`), certificate validation against system CAs, and HTTP `Host` headers.
3. Extended Readiness Timeout & Exponential Backoff:
   - Configurable `VerifyTimeout` with 120s default (up from 35s).
   - Exponential backoff starting at 500ms, doubling up to 5s (`delay = min(delay*2, 5*time.Second)`).
4. Live Verification and Clipboard Integration:
   - Verified live with real Cloudflare Quick Tunnel in foreground tmux session `bridge-connect`.
   - Public MCP URL automatically copied to Wayland clipboard using `wl-copy`.

## Final integration sprint A - browser OAuth correction

Baseline at 575f3a2 passed make check. The existing readonly bridge-connect tmux
server and its owned Cloudflare child were inspected and preserved during diagnosis;
DNS readiness fixes 7678c20/575f3a2 were retained. The observed ChatGPT DCR callback
is the documented stable https://chatgpt.com/connector_platform_oauth_redirect.
No OAuth codes, cookies or credentials were printed or approved by the agent.

Missing Origin was already accepted. The consent document set Referrer-Policy:
no-referrer, which the Fetch standard specifies serializes Origin as null on a
navigation form POST. The first GET therefore queued terminal consent, then the
page's automatic POST hit the strict Origin guard and replaced the page with
invalid origin; the unapproved terminal request subsequently expired. Consent
pages now use same-origin referrer policy, suppressing external callback referrers
while preserving the same-origin POST Origin. Present foreign/null unsafe Origins
remain rejected. Safe authorization GET navigation is endpoint-specific; trusted
Host, exact DCR redirect, PKCE, state, CSRF, cookies and terminal approval remain.
Origin parsing now rejects userinfo, paths and queries rather than comparing only
scheme/host. A guard-to-OAuth-to-SDK regression covers the real callback shape,
PKCE failure/success, state echo, invalid redirects/Host/Origin/CSRF, token exchange,
authenticated initialize/list and unauthenticated MCP 401. Direct browser /mcp 401
remains intentional. Real ChatGPT reconnection is pending owner interaction.

The new user sprint explicitly authorizes one controlled readonly public tunnel,
and private kmanisk/bridge-dev repository creation/push after validation and secret
review. This replaces old no-remote/no-public-test restrictions only for this scope.
No public repository, permanent service or real privileged test is authorized.

Browser evidence boundary: the Fetch standard's append-Origin algorithm explicitly
maps no-referrer navigation POSTs to Origin:null. An optional isolated headless
Brave attempt could not load its fixture in this environment (startup/DBus timeout);
it was stopped with its owned process group and the unsuccessful optional harness
was not retained. No actual browser/client completion is claimed from that attempt.
The retained regression exercises the real HTTP guard, cookie/CSRF/PKCE exchange
and SDK rather than weakening the unsafe Origin rule.
Sprint A gates passed: make check (normal/race/vet/staticcheck/Fish), bounded fuzz
952,638 executions and all four CGO-free cross-builds. Real account completion is
not inferred. The tested fix is ready for one inspected readonly-session restart.

## Final sprint C: connection UX and hardening

Implemented immediate wizard field validation/retry, explicit command-list clearing,
dangerous-mode omission of the ordinary allowlist prompt, preservation of existing
partial/active instances, prompt-safe bounded event output, and OAuth denied/expired
callbacks carrying state/iss. Consent deadline is shown; the CSRF-only cookie can
retrieve a failed outcome after authorization expiry and never extends that expiry.
Found and fixed idle starvation: tunnel metadata self-probes previously updated
last activity. Focused race tests pass; complete final gates recorded in TEST_REPORT.

One controlled readonly public tunnel was restarted only after verifying Bridge
ownership, preserving config and private OAuth backups. Public health/TLS passed;
unauthenticated MCP remains 401. The user must reconnect and personally approve
real ChatGPT OAuth; no browser-control surface is available. Active local Codex MCP
fs_list/fs_read/search/fetch read a newly created harmless fixture successfully.
No real Claude account result is claimed. Dashboard explicitly deferred; no stub
or management listener is exposed. gitleaks finds only the deliberately-invalid
Bearer example in current docs and its historical predecessor; reviewed as inert
negative-test literals, not credentials. Source/history scans continue at release.

Final source gates passed: make check (uncached normal/race, vet, staticcheck),
four CGO-free cross-builds/host build, 932,295 bounded filesystem fuzz executions,
22 Fish blocks/completions syntax, and actual subprocess coverage. Unit/subprocess
profiles are 65.6%/40.1%; native terminal/browser/provider paths remain manual.
All source changes reviewed; no credentials/runtime/build files staged. Next step
is private repository publication and final readonly session refresh.
