# Phase 2 verification progress

M10: make check, fuzz and four release builds PASS (test-output/m10-*).
New scripted terminal tests exercise approval/denial/timeouts, independent queued
consents, rate limits, headless refusal, redirect-host and exact-URI checks,
client revocation, resource/session identity, origin invalidation and mode-change
credential invalidation. Existing built OAuth integration explicitly selects the
retained --auth code compatibility flow. Real web-account compatibility is not
implied by these local checks.


M9: full make check, fuzz and four release builds PASS (test-output/m9-*).
New tests cover scripted wizard reuse/reconfigure/override, missing-provider
doctor guidance, clipboard fallback/stdin, prompt serialization/timeout and
actual loopback HTTP verification of a fake public tunnel origin. The fake
transport also checks response bodies and challenges for loopback leakage.


M8: baseline and post-migration make check (uncached normal/race, vet and
staticcheck), path fuzzing and four CGO_ENABLED=0 builds PASS. Logs:
test-output/phase2-baseline-*, test-output/m8-*. Current cloudflared is installed
(version 2026.10.7); it was not launched. Codex 0.167.1 and Fish are available.
The matrix in REQUIREMENTS.md distinguishes subsequent unfinished milestones.

The following retained report is the historical Phase 1 snapshot, not a current
claim about installed tools or Phase 2 functionality.

# Development validation report

Verification date: 2026-11-11. Scope: isolated local development build, not a
production deployment, external security audit or web-account certification.

## Milestone disposition

| Milestone | Implemented and locally verified | Remaining verification |
| --- | --- | --- |
| M1 | Module, CLI, strict configuration/precedence, safe defaults, central identity, docs | None in local foundation scope |
| M2 | Official SDK stdio, filesystem/process tools, annotations, complete registry mode gates | Native macOS/arm64 execution |
| M3 | Atomic writes/edits including lossless binary reads/writes, argv policies, limits, audit, noninteractive sudo construction/preview | Real privileged execution deliberately not tested |
| M4 | Both durable backends, server restart/crash survival, independent final results, collected systemd units, lifecycle/log cursors, monotonic completion acknowledgments | Forced worker death/reboot can lose uncaptured command results; reported lost |
| M5 | Built HTTP probe first, stateless JSON HTTP, local bearer, auth/Host/Origin/limits/concurrency, actual active-request idle behavior | Web account probe results remain unknown |
| M6 | OAuth code/S256, consent/CSRF/state/issuer, resources, public/confidential DCR, expiry/refresh/revocation, built HTTP OAuth-to-MCP, fake tunnel ownership/cleanup | Real cloudflared, Claude Pro/Max and ChatGPT account compatibility |
| M7 | Full local checks, four cross-builds, minimum Go checks, isolated Codex registration, all requested docs/manual checklist | Native platform and human web/privilege checks listed below |

These rows distinguish implementation and local evidence from unrun manual
checks. In particular, M6 is not claimed verified end-to-end through a public
tunnel or any real Claude/ChatGPT account.

## Environment and build

- Host: CachyOS Linux amd64, kernel 7.3.3-1-cachyos, user systemd 262.2 active.
- Go: 1.27.3-X:nodwarf5; minimum declared Go 1.25.0 separately tested.
- Git 2.56.0; Codex CLI 0.167.0; make, python3, curl, jq, gcc and visudo present.
- cloudflared absent. staticcheck installed only in project `.tools`:
  staticcheck 2026.2.2 (module v0.8.2).
- SDK pinned to official `github.com/modelcontextprotocol/go-sdk v1.8.0`.
  SDK-default clients negotiate MCP 2026-07-28. Explicit HTTP tests also cover
  2025-03-26, 2025-06-18 and 2025-11-25. No legacy SSE-only server.
- Binary: `/home/onyx/Projects/bridge-dev/bin/bridge-dev` (about 12 MiB stripped).
- `CGO_ENABLED=0` release builds succeed for Linux amd64/arm64 and Darwin
  amd64/arm64. `file` confirms both Linux artifacts are statically linked ELF;
  macOS artifacts are Mach-O and still use platform system libraries.
- Exact artifact hashes and file types: `test-output/SHA256SUMS` and
  `test-output/file-types.log`. No commit SHA exists: no Git repository or
  commit was created for this project.

## Required gates

| Command | Result | Evidence |
| --- | --- | --- |
| go fmt ./... | PASS | test-output/check.log |
| go vet ./... | PASS | test-output/check.log |
| go test -count=1 ./... | PASS | test-output/final-normal.log |
| go test -race -count=1 ./... | PASS | test-output/final-race.log |
| .tools/staticcheck ./... | PASS | test-output/final-staticcheck.log |
| make fuzz (10s, 2 workers) | PASS; final run 975,427 cases, no failure | test-output/fuzz.log |
| make build cross | PASS, all four targets | test-output/build.log |
| GOTOOLCHAIN=go1.25.0 go test ./internal/... | PASS | test-output/go125.log |
| Isolated Codex add/get/remove | PASS; temporary-home PATH-alias warning only | test-output/codex-registration.json |
| Actual CLI version/config/doctor/sudoers preview/SDK helper smoke | PASS; preview validated by visudo, never installed | test-output/cli-smoke.json |
| Actual CLI HTTP status/down and task list/status/logs/stop | PASS, isolated ephemeral instance and task | test-output/cli-lifecycle.json |

Final normal and race tests were forced uncached after the last implementation
change. The earlier fuzz run completed 1,106,222 cases. The final property-based run
also asserts that every successful read contains only the in-root fixture,
rather than merely checking for a panic. Fuzz success is bounded evidence,
not a proof that no filesystem race is possible.

During race tests, integration subprocesses are built with `-race` and CGO
for instrumentation. Normal integration and every release build use CGO=0.
This tests the real server's concurrency as well as the test harness.

## Coverage and concrete assertions

| Requirement | Evidence |
| --- | --- |
| Missing/invalid config, precedence, modes | internal/config TestConfig; unknown fields/invalid modes/missing explicit file reject |
| Forbidden tools absent and uncallable | integration TestBuiltStdioModes checks all readonly/user tools plus sudo gate and denied invocation |
| Annotations and first HTTP probe | integration TestHTTPProbeBinary checks exactly four tools, readOnlyHint and actual calls |
| Traversal, symlinks, special files, hard-link writes | internal/fsjail TestJail |
| Concurrent path replacement, reads and writes | internal/fsjail TestConcurrentReplacement protects an outside sentinel |
| Permission failures | internal/fsjail TestPermissionFailures ran as ordinary user |
| Path fuzzing | internal/fsjail FuzzPaths, final run above |
| Text/binary write/read and execution via actual SDK | integration TestBuiltStdioModes |
| Command allow/deny, literal argv, output cap, exit 7, timeout | internal/execrun TestExec |
| Forced group termination | internal/execrun TestForcedGroupTermination ignores TERM and requires KILL |
| Direct privilege broker guard | internal/execrun TestDirectPrivilegeBrokerDenied; no broker executed |
| Fake sudo -n -- argv | internal/execrun TestFakeSudo, temporary unprivileged shell fixture only |
| Sudoers preview injection rejection | internal/policy TestSudoersPreview; actual visudo preview smoke |
| Environment omission | internal/execrun TestEnvironment |
| Audit redaction/rotation/concurrency | internal/audit TestMetadataOnlyAndRotation |
| Failed audit prevents side effects | integration TestAuditFailureRefusesSideEffect |
| Systemd + detached restart survival | integration TestDurableTasks, both backends actually ran |
| Result retained after unit collection and second restart | TestDurableTasks observes not-found LoadState, then reopens server and confirms exit 7 |
| Forced MCP process crash | integration TestTaskSurvivesServerCrash kills only its own server child; independent task exits 3 with expected output |
| Stop/restart/forget, incremental logs, ack/no duplicate | TestDurableTasks uses actual lifecycle tools and cursor continuation |
| Monotonic cursor despite clock rollback and forget | internal/tasks TestMonotonicCompletionAndForget |
| Completion/status crash-window recovery | internal/tasks TestRecoveryFromIndependentCompletion |
| Failed backend admission/launch and readable initial logs | internal/tasks TestStartFailureDoesNotPoisonListing |
| Stale process identity refusal without signaling | internal/tasks TestStalePIDIsNeverSignaled |
| Authentication/Host/Origin/size | internal/transport TestHTTPValidation plus built HTTP SDK tests |
| Concurrent HTTP and older protocol JSON responses | TestConcurrentRequests and TestOlderProtocolRequests |
| Idle exit with actual long request | integration TestHTTPIdleKeepsActualRequestAlive uses 2s sleep versus 500ms idle, then verifies automatic exit |
| OAuth PKCE, replay, expiry, revocation, private storage | internal/auth TestOAuthPKCERefreshRevocation, TestOAuthRejectsInvalid, TestLocalToken |
| Confidential client authentication | internal/auth TestConfidentialRegistration |
| Actual built OAuth server and authenticated MCP client | integration TestBuiltOAuthHTTP, including identity in audit and revoked-token rejection |
| Owned tunnel cleanup and URL extraction | internal/tunnel TestOwnedFakeTunnel, fake executable only |
| Remote sudo/dangerous rejection | internal/transport TestRemotePrivilegeDenied |

All integration state, roots, logs, binaries and OAuth consent artifacts are in
isolated temporary directories. Product config environment overrides are stripped
from child test environments; a user's existing tunnel setting cannot cause a
public test launch. Controlled shell fixtures operate only on temporary test
workloads. No actual sudo, real sudoers writes, real user-process kills, public
test listener or public tunnel occurred.

## Failures found and resolved

1. Initial integration fixtures had publicly accessible state permissions. The
   server correctly refused them; fixtures now create 0700 directories.
2. Initial concurrent-write design used a validated existing inode. It was
   replaced with fresh-inode atomic rename to avoid hard-link mutation races.
3. Initial command cleanup could reap a group leader before final signaling.
   Linux waitid WNOWAIT / Darwin kqueue now retain it until signals are complete.
4. Detached worker release could leave zombies while a parent stayed open.
   Parents now wait asynchronously without tying worker lifetime to MCP.
5. Initial completion cursor depended on wall-clock time and task retention.
   Independent records and a durable sequence now survive rollback and forget.
6. staticcheck found numeric HTTP status literals; corrected to named constants.
7. Instrumented workers outlived a fixed 200ms collection assertion. The test now
   observes actual unit state with a bounded deadline before checking recovery.

8. A rejected backend could leave an incomplete task directory that broke listing.
   Admission now cleans up; actual launch failures retain a valid failed record
   and readable initial log. Regression and stale-identity tests pass.

## Outstanding behavior and limits

- No known failing local test remains. This is still unreviewed development
  software; passing tests do not establish Internet-facing production safety.
- cloudflared is unavailable, so real tunnel connectivity/forwarding/exit behavior
  remains unverified; only orchestration against a fake process is proven.
- Claude Pro/Max and ChatGPT account connectors were not created. ChatGPT Plus
  write access is unknown. MANUAL_TEST.md contains a dated, unfilled probe table;
  account restrictions are compatibility limits, not presumed server failures.
- Native macOS and Linux arm64 execution is unverified. macOS relies on os.Root
  and trusted mount/device setup; it has no verified defense against same-account
  device creation/mount replacement. Linux requires openat2 and mounted /proc.
- Client ID metadata document registration is not implemented; clients must use
  RFC 7591 registration. Current MCP retains DCR for backward compatibility.
- Aggregate task/event storage and task count have no global quota. Individual
  task output and audit rotation are bounded. Detached/macOS live CPU/RAM
  sampling is absent; normal final usage is retained.
- Forced worker death/reboot before a result is captured can leave `lost`; the
  server refuses stale-PID signaling. Storage/audit failures during completion
  retain an active retrying finalizer; restoring storage lets it finish. No
  blind automatic restart of argv occurs.
- Atomic writes replace inode identity and ordinary permission bits only; they
  do not preserve ownership, ACLs or extended attributes. Linux ordinary modes
  reject even internal symlinks and nested mount crossings.
- Command allowlisting is not an OS sandbox; allowed interpreters can invoke
  arbitrary capabilities, including privilege brokers. The direct broker guard
  does not change that boundary. Sudoers must independently constrain privilege.
- search/fetch preserve filesystem semantics, not a full ChatGPT deep-research
  results schema. Read-only filename search is bounded and is not content grep.

## Manual work still required

Follow MANUAL_TEST.md for actual Claude/ChatGPT OAuth discovery, tool listing,
read behavior and dummy-write confirmation/blocking, the current ChatGPT plan,
a deliberate real Quick Tunnel launch/teardown, native macOS/arm64 validation,
and isolated human review of any future privileged policy. Real sudo and local
dangerous data operations remain intentionally disabled in development tests.
No public exposure or privileged verification should be inferred from this report.

Final cleanup: no bridge-dev process or loaded unit remains; no persistent
bridge-dev unit file exists. Release artifact hashes were rechecked successfully
after the final task admission fix.
