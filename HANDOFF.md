# Phase 2 handoff

M8-M15 local implementation and regression are complete. Read REQUIREMENTS.md,
TEST_REPORT.md and NOTES.md for evidence, exact remaining human gates and intentional
replacements of Phase 1 restrictions. This is a continuation, not a rewrite.

Binary: /home/onyx/Projects/bridge-dev/bin/bridge-dev. Start with bridge-dev connect;
stop with bridge-dev down. First run asks preferences; later runs reuse private
TOML. No live configuration or permanent service was installed during automation.
Local verified milestone commits are authorized; no remote/push/publication.

Final make check/fuzz/cross/build/coverage passed. Unit coverage 64.7%, actual
instrumented subprocess coverage 43.6%. Final fuzz run: 979,426 executions. Go MCP
SDK v1.8.0; module github.com/kmanisk/bridge-dev; temporary name remains unchanged.
The built artifact predates the final milestone commit and records its parent
plus modified=true in VCS metadata; its tested source is the final M15 code.

Tests use temporary state, fake sudo/cloudflared/client executables, and loopback
HTTP proxies. Never run real sudo or public relays in automated tests, alter the
user's MCP configs, kill unrelated processes or delete active task state. No
Bridge process/loaded user unit remained after validation. Native client/account,
Cloudflare, macOS/ARM64, actual sudo cache and deliberate dangerous-mode checks are
still manual. Do not call them verified because local OAuth/SDK tests pass.

Desktop Commander was reviewed at 9d5afdf5da6bdee4d4c52caf9a78128235a1b0d4 using
actual source/tests and MIT license. See docs/DESKTOP_COMMANDER_COMPARISON.md. No
Node/npm dependency or copied code was added. Ignored .research, .tools, bin,
coverage and test-output are local artifacts; do not commit credentials or build
outputs. Current source includes canonical origin recovery, terminal OAuth,
client revocation, exact-operation approvals, durable at-most-once dispatch with
unknown crash outcomes, timed privileges, sudo context safeguards, safe client
registration, status/watch/down recovery and paginated file operations. Keep the
jail, audit, per-call authorization and independent durable workers intact.
