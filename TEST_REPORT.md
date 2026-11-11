# Verification report

Verified 2026-11-11 on CachyOS Linux amd64, Go 1.27.3-X:nodwarf5, official MCP Go
SDK v1.8.0. Phase 1 regression behavior is retained. This is local implementation
and test evidence, not an independent security audit or proof of external AI access.

## Historical M15 baseline

The following M15 results and artifact fingerprints predate the final integration
sprint. Current sprint gates/results are in the final section below.

| Gate on M15 code | Result | Evidence |
| --- | --- | --- |
| go fmt ./... | Pass | test-output/m15-check.log |
| go vet ./... | Pass | same log |
| go test -count=1 ./... | Pass | same log; real built server subprocesses |
| go test -race -count=1 ./... | Pass | same log; race-built actual servers |
| .tools/staticcheck ./... | Pass | same log; installed staticcheck 0.8.2 |
| make check | Pass | includes all above plus Fish checks |
| Filesystem fuzz/property/race tests | Pass; 979,426 fuzz executions in final 10s run | test-output/m15-fuzz.log |
| Fish completions and 20 manual Fish blocks | Syntax pass without execution | make fish-check; scripts/check-fish |
| Linux amd64/arm64, macOS amd64/arm64 | All cross-builds pass with CGO_ENABLED=0 | test-output/m15-cross.log |
| Host release build | Pass; statically linked ELF, CGO_ENABLED=0 | test-output/m15-build.log; file/go version -m |
| Direct unit coverage | 64.7% statements | coverage/unit.out; coverage/unit-functions.txt |
| Actual server subprocess coverage | 43.6% statements | go build -cover + GOCOVERDIR; coverage/subprocess.out and subprocess-functions.txt |
| Native installed Codex add/get/remove | Pass in temporary CODEX_HOME | internal/clientinstall/install_test.go; Codex 0.167.1 |
| Secret/diff review | git diff --check passed; no runtime credential files staged | local milestone review |

Coverage percentages are separate profiles, not an invented combined percentage.
Subprocess coverage measures actual instrumented main/stdio/HTTP/OAuth/task worker
processes, not only handler mocks. Abruptly killed processes cannot flush all Go
coverage counters; their crash behavior is still asserted. Interactive /dev/tty,
real sudo/visudo installation, actual cloudflared/native account setup, native
macOS/ARM64, GUI clients and provider account paths remain unexecuted. Fake-provider
recovery and scripted prompts are primarily covered by unit/in-process HTTP tests,
so subprocess coverage alone does not describe those features. Error/storage paths
also remain partly uncovered. Reports list per-function gaps; no 100% claim is made.

## Verified functionality

M8 foundation/migration, M9 guided connect, M10 terminal OAuth/sessions, M11 approvals
and durable dispatch, M12 privileged modes/grants/detach, M13 local client integration,
M14 reliability/file pages and M15 regression/documentation are implemented locally.
REQUIREMENTS.md maps specification sections and evidence. Local commits before M15:

| Milestone | Commit |
| --- | --- |
| M8 | e14f18c |
| M9 | b968603 |
| M10 | c5cef01 |
| M11 | bbbc1c9 |
| M12 | 9a2dd43 |
| M13 | e22d85a |
| M14 | 902b55d |

M15 is the commit containing this final report; its hash is reported by the agent
and git log. Artifacts were built from the final tested code before that commit,
so embedded VCS metadata records its parent with modified=true. No release was
published. The binary remains /home/onyx/Projects/bridge-dev/bin/bridge-dev.

Actual binary clients exercise stdio, stateless JSON Streamable HTTP, legacy older
protocol versions, OAuth-authenticated HTTP and privileged OAuth with a failing
fake sudo. The long HTTP command test returns a pending ID before 25 seconds,
polls its final exit, retries its original request_key, and verifies one dispatch.
Durable task tests cover server crash/restart, systemd collection, exit preservation,
log offsets, cancellation, PID reuse safeguards and independent completion cursors.

Scripted tests cover wizard/reuse/reconfigure/precedence, missing tools, terminal
serialization, consent yes/no/timeout/rate limits/queues, exact redirects, session
expiry/revocation, refresh rotation, origin invalidation, approvals yes/no/always,
headless refusal, concurrent retry deduplication, modified requests, crash unknown
outcomes, pre-execution audit failure, grant expiry and dynamic tools/list. File
unit/race/fuzz tests retain traversal, symlink/mount, hard-link, atomic replacement,
permission, output and cleanup checks. Direct identity/platform/filesystem/server
tests were added. Watch rotation and public up URL output have regression tests.

## Security review findings corrected in this phase

- Removed both transport-policy and leftover OAuth-constructor categorical remote
  privilege bans, replacing them with current startup/OAuth/session authorization.
  A positive fake-tunnel OAuth test caught the second ban after M12; M14 fixes it.
- Canonical public origins are verified before advertisement; token/resource metadata
  never advertises loopback in fake-public tests. Rotation invalidates credentials
  and grants, including previously captured authorization objects.
- Timed privileged tokens/refresh sessions are clipped to grant expiry; scope and
  mode are checked per call and immediately before process launch.
- Pending intent is not logged as an allowed/completed operation. Audit failures
  refuse sensitive dispatch; command arguments/contents/tokens are omitted.
- Closed both dangerous and safe fallback root handles; guarded task-resource
  representations against bypassing approve=all tool gates.
- Sudoers installation checks the exact preview digest/visudo snapshot and uses
  no-replace atomic linking, protecting a concurrently created administrator rule.
- DCR bounds are concurrent stored-state bounds: revoked/expired registrations can
  be pruned, rather than forming a lifetime registration quota.
- Fixed up --tunnel to print the verified public /mcp URL, not merely loopback.
- Diagnosed and fixed Cloudflare Quick Tunnel startup verification failure (`endpoint unreachable`):
  implemented local readiness check, exponential backoff, early child exit detection, full stdout/stderr
  capture, accurate error classification (DNS, TLS, TCP, 1033, 502, 401/403), instance token matching,
  and structured diagnostic error reporting. Added comprehensive regression tests across `transport`,
  `tunnel`, and `connect`.
- Resolved public DNS negative caching in `VerificationClient`: added edge connection synchronization (`WaitRegistered`),
  scoped fallback DNS resolver querying `1.1.1.1:53` and `8.8.8.8:53`, public IP validation rejecting private/loopback
  rebinding, strict TLS SNI/CA verification preservation, and 120s readiness timeout with exponential backoff.

## Real Cloudflare Quick Tunnel Test Results (Live Verification)

| Check | Target / Host | Result | Evidence |
| --- | --- | --- | --- |
| Edge Registration Synchronization | `cloudflared tunnel --url http://127.0.0.1:8765` | PASS | `registered connIndex=0` detected before external verification |
| Local Resolver State | `remembered-glory-norm-mobiles.trycloudflare.com` on `127.0.0.53:53` | PASS (Diagnosed) | Local stub resolver returned `NXDOMAIN` due to 60s negative caching |
| Public Fallback DNS Lookup | `1.1.1.1:53` / `8.8.8.8:53` | PASS | Resolved to `104.16.230.132` and `104.16.231.132` |
| Verification Client Fallback Resolution | Scoped `VerificationClient` with `CheckDNS` | PASS | Transparently bypassed local negative cache, connected via fallback IP |
| Public HTTPS Reachability | `https://remembered-glory-norm-mobiles.trycloudflare.com/healthz` | PASS | HTTP/2 200 OK, `ok mode=readonly`, `x-bridge-instance` verified |
| TLS Certificate & SNI Verification | `*.trycloudflare.com` certificate via Google Trust Services | PASS | TLSv1.3 handshake verified using system root CAs, zero insecure bypasses |
| OAuth Authorization Server Metadata | `/.well-known/oauth-authorization-server` | PASS | HTTP/2 200 OK, issuer matches public origin, no loopback references |
| OAuth Protected Resource Metadata | `/.well-known/oauth-protected-resource/mcp` | PASS | HTTP/2 200 OK, resource matches public `/mcp`, single authorization server |
| Unauthenticated MCP Challenge | `POST /mcp` without Bearer token | PASS | HTTP/2 401 Unauthorized, `WWW-Authenticate` header present with resource metadata |
| Post-TTL Local DNS Expiry | `resolvectl query` after 60s TTL | PASS | Successfully resolved to `104.16.230.132` and `104.16.231.132` |
| Direct Public Access | Direct curl without `--resolve` after TTL | PASS | HTTP/2 200 OK |
| Wayland Clipboard Integration | `wl-copy` / `wl-paste` | PASS | MCP URL copied to clipboard: `https://remembered-glory-norm-mobiles.trycloudflare.com/mcp` |
| Foreground Session Persistence | Dedicated tmux session `bridge-connect` | PASS | PID 178282 running, ready for manual interactive OAuth consent |

## Remaining limitations and manual gates

At M15, no failing automated check remained. No claim was made for real Claude Code,
Claude Desktop/web, ChatGPT/Plus write access, actual public Cloudflare/named DNS,
user sudo cache behavior or native macOS/ARM64 execution. Follow MANUAL_TEST.md and
record actual account/workspace/version/date/results. OAuth success is not proof
of provider write-tool support. CIMD is optional, unimplemented and not advertised;
use DCR. Desktop registration is a manual snippet merge/removal. Unverified custom
CLAUDE_CONFIG_DIR layouts use print-only instructions instead of guessed edits.

Darwin device/no-follow/descriptor behavior needs native validation. Privileged
background tasks require Linux systemd and independent noninteractive authorization
in the worker's context; a successful foreground sudo -v is not sufficient proof.
Special-file I/O is unsupported by file tools. Atomic replacements do not preserve
ownership/ACLs/xattrs. Directory/search cursors are offsets rather than snapshots.
A force-killed worker or reboot can yield lost/unknown; no exactly-once claim exists.

Resource bounds are not billing quotas. Total retained task/receipt storage still
requires operator management; tombstone deletion weakens historic retry protection.
Filesystem/command allowlists are not OS sandboxes. Broad write or execution grants
can undermine user-owned programs/configuration/state; keep roots narrow. Prompt
injection and third-party provider observation remain real risks. Review SECURITY.md.

## Artifact fingerprints

| Artifact | SHA-256 |
| --- | --- |
| bridge-dev / bridge-dev-linux-amd64 | e5fa182a4a43396c242abc56cff50b188f5b7b6802f8f4133c065626b4af2377 |
| bridge-dev-linux-arm64 | 892e29b3669d1c8b86ee0097eee9fb51d5bb1b6641b6c37959c265d4a5f4cc33 |
| bridge-dev-darwin-amd64 | 42c24db7757cabf2f9f190ec1daf5a03070d2b26e1e9772857769ecc220b75b8 |
| bridge-dev-darwin-arm64 | f48994bd1d679fc5b6a5feedbf6f5499bc98aabedde01a49b41e021baf1aa407 |

Final cleanup check found no bridge-dev process or loaded bridge-dev user unit.
No permanent unit, live client configuration, sudoers file or workstation setting
was installed/changed by automation. No public tunnel, real sudo, Git remote,
push, publication or deployment occurred. Generated builds/reports/research stay
ignored; committed files contain source, tests and documentation only.

## Final sprint A

Baseline make check at 575f3a2 passed. OAuth guard-to-consent/PKCE/token/SDK tests
pass with the real ChatGPT stable callback shape and temporary state. Browser
navigation without Origin reaches consent; invalid Host/unsafe Origin/redirects
remain rejected. Consent documents advertise same-origin referrer policy to avoid
Origin:null on automatic form POST. Native isolated browser reproduction is an
optional explicitly selected local test; actual ChatGPT browser completion remains
pending. Final sprint results and private GitHub state will be recorded below.
Sprint A complete local gate: make check/race/staticcheck, 952,638 bounded fuzz
executions and four cross-builds passed (test-output/sprint-a-*). Headless Brave
could not load the isolated fixture here; real browser approval is still pending.

## Final integration sprint (2026-11-11)

Source baseline was 575f3a2 (with DNS/readiness fixes 7678c20 and 575f3a2).
Sprint A commit 54ae0e2 corrected browser consent origin handling. GET without
Origin was already accepted. The consent document's no-referrer policy causes
navigation form POST Origin:null under Fetch; the guard correctly rejected null.
Same-origin referrer policy fixes the form while retaining strict unsafe-Origin
validation. This source/standard diagnosis matches the observed pending/expiry
sequence; the real browser's request headers were not captured. The new regression
covers canonical/invalid Host, exact observed ChatGPT DCR callback, redirects,
CSRF, PKCE, state/iss, consent, token exchange, SDK initialize/tools/list and 401.

Additional fixes: immediate per-field wizard retries; preserve existing/partial
runtime; terminal events buffered during prompts with a 64 KiB presentation bound;
clear consent expiry instructions and validated access_denied callbacks; discovery
self-probes excluded from idle activity. No privilege checks were relaxed.

| Feature | Implemented | Tested | Manual check | Evidence |
| --- | --- | --- | --- | --- |
| Browser OAuth navigation/form/PKCE/CSRF/token/MCP | Yes | Passing direct guard/SDK and built-binary tests | Real ChatGPT completion pending | transport/oauth_browser_test.go; auth/terminal_test.go; integration/oauth_test.go |
| Wizard/reuse/typos/duplicate-start protection | Yes | Scripted, fake tunnel, partial-lock tests | Normal interactive review | connect tests |
| Prompt serialization/event output | Yes | Scripted concurrency/timeout/bounded buffer | Real terminal consent pending | prompt tests; auth tests |
| Strict privilege/audience/revoke/dedup/filesystem controls | Retained | Existing security/race/crash regressions | Real sudo/dangerous deliberately not run | approval, mcpserver, fsjail, execrun, tasks tests |
| Local Codex MCP | Yes | Actual active fs_list/fs_read/search/fetch against new harmless fixture; isolated registration | GUI clients separate | local MCP tool results; clientinstall tests |
| Built stdio/HTTP/OAuth and durable tasks | Yes | Actual built SDK clients; short task and crash/collection recovery | Native alternate OS remains pending | integration tests |
| Real Cloudflare readonly transport | Yes | Public DNS/TLS/health, public AS/PR discovery and 401 challenge | Connector re-entry after rotated URL | Controlled manual runtime, separate from tests |
| ChatGPT account | Connector creation/OAuth initiation observed by user | Callback/tools not yet proven | User reconnect, terminal y, read call | Preserved registered client; no authorized activity yet |
| Claude web account | Protocol/DCR implemented | Automated protocol only | Real account authorization/read pending | No actual account access available |
| Optional dashboard | No; deferred | No | Explicitly incomplete | No new listener/authentication surface |
| Private GitHub | Authorized | Publication verification pending | No human login needed so far | Existing gh identity kmanisk |

Final gate results are recorded after command completion below. Native macOS/ARM64,
real Claude/ChatGPT write availability, named tunnels and user sudo contexts remain
manual. No real sudo, dangerous user-data operation or public tunnel is part of
make check/coverage/fuzz. The separately controlled public runtime is readonly and
uses only a new temporary hello.txt root. Original saved config, registrations,
existing stdio processes and tasks are preserved. No permanent service installed.

Independent source review checked per-call scope/mode/grant revalidation,
origin-bound tokens and refresh revocation, exact approval digests/session binding,
durable dispatch/unknown outcomes, pinned Linux filesystem operations, literal argv,
pre-side-effect audit persistence and local admin separation. These tests/source
checks are not a formal security audit. Allowlisting is not an OS sandbox; prompt
injection and external-provider observation remain material risks.

Gitleaks full Git history and tracked worktree scans reported only the inert
Bearer deliberately-invalid documentation example (two history findings, one
current-source finding). Each exact literal was reviewed; zero actual credentials
found. Historical filenames were reviewed for state/config/credential/binary paths;
none found. Private machine configuration/data were not added. Build artifacts,
private runtime/auth state, .env, logs and native tunnel credentials are ignored.
The optional isolated headless browser attempt could not load its fixture; it was
stopped and its uncommitted harness removed. It is not browser compatibility proof.

### Final source gates

| Gate | Result | Local evidence |
| --- | --- | --- |
| go fmt/vet/uncached tests/race/staticcheck; make check | Pass | test-output/sprint-final-check.log |
| Actual built stdio/HTTP/OAuth/task subprocesses | Pass, normal and race instrumentation | integration suite in same log |
| Bounded filesystem fuzz | Pass; 932,295 executions, 10 seconds, 2 workers | test-output/sprint-final-fuzz.log |
| Four CGO_ENABLED=0 release cross-builds and host build | Pass | test-output/sprint-final-build.log |
| Fish completions and all 22 manual Fish blocks | Syntax pass, no fixture commands executed | test-output/sprint-final-fish.log |
| Unit / actual subprocess coverage | 65.6% / 40.1%, separate profiles | coverage/unit-functions.txt; subprocess-functions.txt |
| Diff whitespace / secret review | Pass with reviewed inert negative-test literals | git diff --check; redacted sprint-*-secrets reports |

The previous M15 artifact hashes/coverage above are historical, not fingerprints
for these changed sources. Current artifacts are ignored under bin/. Native
macOS/ARM64 execution and actual provider handshakes remain separate manual gates.
