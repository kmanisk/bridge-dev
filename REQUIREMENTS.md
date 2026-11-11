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
| M12 effective privileges, sudo, dangerous, grants, detach | No | No | No | Planned |
| M13 local-client install/print/uninstall | No | No | No | Planned |
| M14 status/watch/down, tunnel recovery and task events | No | No | No | Planned |
| M14 bounded read/search improvements from reference | No | No | No | Planned |
| M15 direct package tests, subprocess coverage, Fish docs/completions | No | No | No | Planned |
| M15 final full regression, fuzz, four release builds | No | No | No | Planned |
| Actual Claude / ChatGPT / public Cloudflare / native macOS / real sudo | No claim | Not run | Manual environment/authorization | MANUAL_TEST.md |

No Bridge telemetry/accounts/relay infrastructure, usage quota, permanent service,
remote, push or publication may be introduced at any milestone. Automated tests
use fake sudo/tunnel/client binaries and temporary isolated directories only.

CIMD is optional under the current specification and is not implemented. Dynamic
registration remains required and tested; do not claim published-identity client
registration works. Explicit client registration metadata is self-reported.
