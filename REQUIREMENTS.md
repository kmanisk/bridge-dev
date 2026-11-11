# Phase 2 implementation and verification matrix

User specification sections 1-41 are the acceptance contract. No unfinished
requirement is converted into a completed limitation. External/manual checks
remain explicitly separate from local implementation.

| Requirement | Implemented | Tested | Blocked | Evidence |
| --- | --- | --- | --- | --- |
| M8 baseline and local Git | Yes | Full baseline passed | No | test-output/phase2-baseline-* |
| M8 pinned Desktop Commander implementation research | Reviewed | Static source/license review | No | docs/DESKTOP_COMMANDER_COMPARISON.md |
| M8 module, identity and reversible config migration | Yes | make check, fuzz, four builds passed | No | internal/config, internal/identity |
| M9 wizard, connect, verified startup, clipboard, instructions | Yes | Scripted wizard/reuse/reconfigure/precedence, fake tunnel public metadata, clipboard, full regression | No | internal/connect/connect_test.go; test-output/m9-* |
| M10 serialized prompts, OAuth terminal consent, sessions/revocation | Yes | Approve/deny/timeout/rate, redirect/queue/revoke/origin tests; full regression | No | internal/auth/terminal_test.go; test-output/m10-* |
| M11 approval queues, polling, durable request deduplication | Yes | Scripted approvals/retries/revocation/crash, MCP polling, full regression | No | internal/approval/manager_test.go; internal/mcpserver/server_test.go; test-output/m11-* |
| M12 effective privileges, sudo, dangerous, grants, detach | Yes | Fake sudo/systemd, phrase/manual ack, expiry, mode registry, worker context and installer snapshot tests | No | internal/privilege; internal/tasks/privileged_test.go; test-output/m12-* |
| M13 local-client install/print/uninstall | Yes; Desktop snippet/manual merge | Fake client tests plus native isolated Codex add/get/remove; full regression | No | internal/clientinstall/install_test.go; docs/LOCAL_CLIENTS.md; test-output/m13-* |
| M14 status/watch/down, tunnel recovery and task events | Yes | Fake rotation, real HTTP OAuth, old-token/grant invalidation, partial state, lifecycle regression | No | internal/connect/recovery_test.go; internal/transport/status_test.go; test-output/m14-* |
| M14 bounded read/search improvements from reference | Yes | Direct slices/pages/content/traversal tests; configurable output tests | No | internal/filesystem; internal/execrun/exec_test.go |
| M15 direct package tests, subprocess coverage, Fish docs/completions | Yes | 64.7% unit / 43.6% subprocess; 20 Fish blocks checked | No | coverage/*; internal package tests; test-output/m15-* |
| M15 final full regression, fuzz, four release builds | Yes | Final make check/fuzz/cross/build/coverage all pass | No | TEST_REPORT.md; test-output/m15-* |
| Actual Claude / ChatGPT / public Cloudflare / native macOS / real sudo | No claim | Not run | Manual environment/authorization | MANUAL_TEST.md |

No Bridge telemetry/accounts/relay infrastructure, usage quota, permanent service,
remote, push or publication may be introduced at any milestone. Automated tests
use fake sudo/tunnel/client binaries and temporary isolated directories only.

CIMD is optional under the current specification and is not implemented. Dynamic
registration remains required and tested; do not claim published-identity client
registration works. Explicit client registration metadata is self-reported.

## Specification section coverage

All statuses below concern local implementation. External human acceptance is
explicitly pending, not converted into a software implementation success.

| Requirement | Implemented | Tested | Blocked | Evidence |
| --- | --- | --- | --- | --- |
| 1 continuation and single connect command | Yes | Scripted startup + HTTP fixtures | No | internal/connect; HANDOFF.md |
| 2 Go/official pinned SDK/minimal dependencies/on-demand/no quotas | Yes | Build info, all gates, state-cap pruning test | No | go.mod; Makefile; auth/terminal_test.go |
| 3 truthful trust/security wording | Yes | Documentation/source review | No | README; SECURITY; THREAT_MODEL |
| 4 preserve tree/bootstrap/baseline/local-only Git | Yes | Baseline logs and local commits | No | NOTES M8; .git/config has no remote |
| 5 four modes, registry and per-invocation enforcement | Yes | SDK lists, scope/auth failures, expiry | No | mcpserver/server_test.go; integration |
| 6 wizard/preferences/precedence/doctor/missing cloudflared | Yes | Scripted first/reconfigure/reuse/missing tests | No | connect/connect_test.go; config tests |
| 7 startup order/public origin verified before success | Yes | Fake public health/AS/PR/challenge tests | No | transport/verify.go; connect tests |
| 8 clipboard and exact client instructions | Yes | Fake wl-copy/fallback; official doc review | Account UI unverified | connect/clipboard.go; MANUAL_TEST |
| 9 authenticated ID vs self-reported name/live events | Yes | SDK initialize name assertions; task/auth tests | Real provider identity never inferred | events; mcpserver tests |
| 10 quick/none/custom argv/restart/cleanup | Yes | Owned fake tunnel and changed-host tests | Actual provider unverified | tunnel; connect/recovery_test.go |
| 11 optional named setup/quick reset/native credentials | Yes | Scripted native argv only | Real account/domain action manual | tunnel/setup_test.go; docs/TUNNELS |
| 12 public metadata/resource/challenge/origin invalidation | Yes | No advertised loopback; old token/grant fail | No | connect/recovery_test.go |
| 13 terminal consent/PKCE/CSRF/rates/redirects/refresh | Yes | Real HTTP plus scripted approval/denial/timeouts | Actual web ceremony manual | auth tests; integration/oauth_test.go |
| 14 DCR/persistent clients/list/revoke/expiry | Yes; optional CIMD excluded | Revocation/replay/sessions/state pruning | CIMD not advertised | auth/clients.go; auth tests |
| 15 startup phrase/manual ack/OAuth-only privileges | Yes | Prompt/manual/headless/auth tests | Real TTY auth manual | privilege/grant_test.go |
| 16 Prompter/coordinator/queues/timeouts | Yes | Serialized scripted prompts and queued clients | Actual /dev/tty path manual | prompt tests; auth/approval tests |
| 17 none/sudo/write/all, y/N/class-session a | Yes | Policy/timeout/session tests | No | approval/manager_test.go |
| 18 random pending IDs/own-client polling/digest/ceiling | Yes | SDK polling + actual 27s command response/retry | No | integration/pending_test.go |
| 19 transient detached up/headless refusal | Yes on Linux systemd | Fake unit + gated-headless tests | Native detached session manual | transport/detach_test.go |
| 20 unrestricted default sudo, optional allowlist/TTY/sudoers | Yes | Fake sudo and immutable installer snapshots | Real root installation manual | execrun, privilege tests |
| 21 worker cache context and sudo -n system units | Yes | Fake launcher + durable failed worker result | Actual system-context NOPASSWD manual | tasks/privileged_test.go |
| 22 timed grants downgrade/no queued expired dispatch | Yes | Tokens/refresh/registry/queue/pre-launch checks | No | auth, privilege, server tests |
| 23 dangerous no root/command jail, optional shell, audit | Yes | Registration/policy/safe fixture output/cleanup | Real dangerous approval manual | mcpserver, policy, execrun tests |
| 24 Phase 1 tasks/resources/durability/cursors/CPU/memory | Yes | Crash, collection, logs, lifecycle/resources | Native platforms manual | tasks; integration; server resource tests |
| 25 durable at-most-once dispatch/unknown crash outcomes | Yes | Parallel retry and subprocess crash tests | No exactly-once claim | approval/manager_test.go |
| 26 per-client completion acknowledgment and human task CLI | Yes | Phase 1 event/lifecycle regression | Cannot wake conversations | tasks event tests; integration |
| 27 local client registration/preview/owned uninstall | Yes; Desktop snippet/manual merge | Fake Codex/Claude and native isolated Codex | Real Claude clients manual | clientinstall tests; docs/LOCAL_CLIENTS |
| 28 status/watch/down/partial state/safe ownership | Yes | Missing/locked/fallback state, watch rotation | No blind process discovery/kill | transport/status_test.go |
| 29 metadata audit/rotation/redaction/reasons/failure refusal | Yes | Secret omission, rate limits, storage failure | Same-user tamper not prevented | audit/transport/integration tests |
| 30 retained jail/atomic writes/mount/symlink/hardlink bounds | Yes | Linux races/fuzz/property tests | Darwin native races manual | fsjail; filesystem tests |
| 31 literal argv/cwd/env/timeout/output/process groups | Yes | Execution/output/shim/group tests | Allowlisting is not a sandbox | execrun; integration |
| 32 module/temporary identity | Yes | Direct identity/build metadata tests | No final naming requested | identity; go.mod |
| 33 Fish manual/completions/no live shell installation | Yes | fish -n + 20 parsed Fish blocks | No | completions; scripts/check-fish |
| 34 direct package and actual subprocess coverage | Yes | 65.6% unit; 40.2% subprocess (final sprint) | Uncovered paths listed, not hidden | coverage/*; TEST_REPORT |
| 35 required interaction/security/recovery tests | Yes locally | Scripted/fake/native isolated cases | Human-only cases explicitly pending | TEST_REPORT; MANUAL_TEST |
| 36 full uncached normal/race/vet/staticcheck/fuzz/build gates | Yes | Final code all pass | No | test-output/m15-* |
| 37 M8-M15 incremental local milestones | Yes | Verified milestone commits | No | git log; NOTES |
| 38 acceptance notes/matrix/diff/secret reviews/local commits | Yes | Review at each milestone | Final sprint private-only scope supersedes old restriction | NOTES; TEST_REPORT |
| 39 documentation and restoration/cleanup/manual environment list | Yes | Fish syntax + source/doc review | External results unclaimed | README; MANUAL_TEST; HANDOFF |
| 40 final verified report/binary/commit/stop instructions | Yes | Version/help/artifact/cleanup checks | Human gates remain | TEST_REPORT; final response |
| 41 pinned actual Desktop Commander source/tests/design research | Yes | Static MIT source review plus adopted feature regressions | No upstream execution/dependency | docs/DESKTOP_COMMANDER_COMPARISON |

Task resources expose status/log representations when reads are ungated. With
approve=all they are not advertised; use the gated task tools so a resource cannot
bypass approval. No Phase 1 tool was removed. No mandatory local requirement is
currently blocked; the manual environment rows are outstanding acceptance evidence.

## Final integration sprint matrix

| Feature | Implemented | Tested | Manual check | Evidence |
| --- | --- | --- | --- | --- |
| OAuth browser navigation/form Origin fix | Yes | Guard-to-OAuth/PKCE/SDK regression | Real ChatGPT pending | internal/transport/oauth_browser_test.go |
| Previous public DNS/TLS readiness fixes | Preserved | Baseline make check | Existing readonly tunnel inspected | 7678c20, 575f3a2 |
| Private GitHub creation and push | Yes | PRIVATE and source cb564c6 matched remote main | Final follow-up verified after push | Sprint E publication receipt |
| Dashboard | No; explicitly deferred | Not tested | Optional UI remains incomplete | Core MCP/security gates prioritized |
| Wizard per-field validation and duplicate startup | Yes | Scripted typo/reuse and held partial runtime lock | No live config changes | connect/connect_test.go |
| Idle lifetime unaffected by tunnel metadata probes | Yes | Direct discovery regression; existing active-request/idle integration | Public runtime updated after tests | transport/http_test.go; integration/lifecycle_test.go |
| Forking clipboard helper cannot block startup/shutdown | Yes | Fake bounded owner; actual live recovery | Final foreground run checked separately | connect/connect_test.go |
| Prompt-safe terminal events and consent expiry callbacks | Yes | Bounded buffer/cancel/serialization; state/iss/code issuance tests | Real browser confirmation pending | prompt/prompt_test.go; auth/terminal_test.go |

Historical no-remote/no-public-exposure rows describe earlier milestone authority;
final sprint private publication/controlled readonly testing replaces them only in
the explicit scope recorded in docs/SUPERSEDED_RESTRICTIONS.md.

## 2026-11-11 OAuth consent browser regression addendum

| Requirement | State | Evidence / remaining gate |
| --- | --- | --- |
| Browser 303 to registered callback despite consent CSP | Implemented and real-Chromium tested | Only exact registered callback origin added to form-action on both consent pages; internal/auth/terminal_browser_test.go; GitHub Actions run 43058478581 |
| Concurrent/polled terminal consent | Implemented and tested | Same validated browser reuses original 303 for 60 seconds, no extra grant; internal/auth/terminal_test.go |
| Safe OAuth diagnostics | Implemented and tested | Missing request/cookie, mismatched cookie/CSRF, expiry, completion reason labels; no credentials or redirect URLs logged |
| Existing security invariants | Retained | Origin/Host, cookies, CSRF, exact redirects, state/iss, PKCE and single-use token exchange in OAuth focused and full-suite tests |
| Real ChatGPT connected MCP read | Not yet verified | Requires user-controlled local rebuild, terminal approval, callback and read call; no automation of user consent |
| Live binary/server/tunnel status | Not verified in this pass | Desktop Commander quota prevented local access; no user session or tasks changed |
