# BridgeDev — repository handoff

## Rust rewrite status: Phases 0–2 verified (2026-11-18)

- **Phase 0 (Node baseline optimization):**
  - Profiling harness (`scripts/bench/harness.mjs`, `mock-provider.mjs`) isolated and verified.
  - Session leaks and heap retainers resolved in `src/lib/mcp-session-manager.ts` and `src/lib/mcp-upstream-manager.ts`.
  - Added bounded session capacity (`MCP_MAX_SESSIONS`, default: 50) with transparent LRU eviction.
  - Added idle session reaping (`MCP_SESSION_IDLE_TIMEOUT_MS`, default: 30m) and unreferenced background timers.
  - Preserved tool cache across idle disconnects to prevent child-process spawn thrashing.
  - Added authenticated `bridge-dev doctor --perf` CLI command and `/diagnostics/perf` gateway endpoint.
  - Performance evidence: Idle RSS 104.12 MiB (<=150 MiB target met), throughput +20% (70.03 calls/sec), p95 latency -54% (205.8ms), soak memory drift -1392 MiB.
  - Verified and committed on `feat/rust-phases-0-2` (commit `597662e`). Full details in `PHASE_REPORT_0.md`.

- **Phase 1 (Behavioral conformance suite):**
  - Codified language-agnostic data-driven vectors in `tests/conformance/vectors/` (`mcp_protocol_vectors.json`, `policy_vectors.json`, `signature_vectors.json`, `ssrf_vectors.json`, `archive_vectors.json`, `provider_vectors.json`).
  - Implemented parameterized black-box runner `tests/conformance/runner.mjs` (80 assertions across SSRF, Archive traversal, Signatures/Leases, Policy tables, CLI `--json` envelope, and Gateway HTTP & MCP transport).
  - Implemented mutation testing suite `tests/conformance/mutation-check.mjs`: verified 100% detection rate across 5 security-critical mutations.
  - Authored authoritative parity specification in `docs/PARITY.md`.
  - Verified 20 consecutive passes with zero flakiness.
  - Verified and committed on `feat/rust-phases-0-2` (commit `934cf4d`). Full details in `PHASE_REPORT_1.md`.

- **Phase 2 (Rust foundation):**
  - Created modular Cargo workspace under `crates/` containing 9 crates: `bridge-types`, `bridge-audit`, `bridge-crypto`, `bridge-net`, `bridge-archive`, `bridge-policy`, `bridge-mcp`, `bridge-gateway`, `bridge-cli`.
  - Documented minimal crate dependencies and security rationale in `docs/RUST_DEPENDENCIES.md`.
  - Enforced workspace lints: `unsafe_code = "forbid"` and `clippy -D warnings`.
  - Implemented "hello gateway" (`bridge-gateway`) and CLI (`bridge-cli`).
  - Built optimized release binaries (`target/release/bridge-gateway`: 3.1 MiB, `target/release/bridge-cli`: 2.7 MiB).
  - Wired Rust binaries to conformance runner via `BRIDGE_IMPL_CMD` and `BRIDGE_GATEWAY_CMD`; verified 80/80 conformance assertions passed (100%).
  - Full details in `PHASE_REPORT_2.md`.

- **Phase Gates & Production Isolation:**
  - Phases 0–2 are fully complete, verified, and committed.
  - Mandatory stop: Phases 3–9 remain strictly unauthorized.
  - Node/TypeScript implementation remains the default released runtime.
  - Production boundaries preserved: no touch of live gateway (PID 822614), host controller, live credentials, or Funnel.

## Shadow-update acceptance (2026-11-17)

Option A implements verified one-download release staging, a rootless Bubblewrap
shadow gateway, a temporary in-namespace `tmpfs` workspace, real independent
MCP SDK negative acceptance, an unchanged signed host-controller lease, a
guarded atomic service cutover, positive-only YOLO smoke, and rollback. The
explicit `bridge-dev update --standard-window` behavior remains available.
The CLI requires an independent local TTY; no model/client can approve or
renew the signed host-root lease. A root-authorized remote agent cannot be
fully prevented from impersonating local execution by TTY checks alone.

The real Linux namespace test `scripts/test-shadow-linux-e2e.mjs` uses
unprivileged Bubblewrap and synthetic release credentials in GitHub Actions,
and must be green before publishing. A few root-owned diagnostic binaries
(`git`, `id`, `echo`) are verified byte-for-byte and mounted read-only in
the *isolated* namespace, because unprivileged user namespaces remap their
host ownership. No executable trust check is relaxed globally. Test fixtures
reset their own permissions before cleanup. CI does not prove the customer's
installed systemd or hardware-specific behavior. Do not equate a GitHub merge
with a live deployment or update a signed lease from MCP.

The earlier failed production update is still a separate operator concern:
the installed gateway may remain at `29cd31c`, STANDARD, until independently
verified. Do not blindly retry or restore authorization. See the durable job
and release pointer first. ChatGPT response interruption and recovery
breadcrumbs are tracked in [issue #10](https://github.com/kmanisk/bridge-dev/issues/10).

BridgeDev is the TypeScript/Node.js MCP development gateway with signed operator approvals and a restricted OS deployment model. This repository **replaces the historical Go prototype**; its source remains accessible in Git history, not in the current working tree.

## Source and verification

- Canonical code: `https://github.com/kmanisk/bridge-dev`, branch `main`.
- Build and test: `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build`, `pnpm run test:policy`, `pnpm run test:all`.
- GitHub Actions `policy-tests` additionally verifies the registered MCP tool inventory against `profiles/native-tool-counts.json`.
- Retain the upstream MIT license and copyright in `LICENSE`.

## Deployment boundary

Owner workflow preference (2026-11-17): for completed product/UI fixes, finish verified CI and publish to GitHub `main`, rather than leaving only a draft PR. A GitHub merge is not production deployment: verify and report the live gateway separately. `bridge-dev update` stages once, runs shadow negative acceptance under an isolated STANDARD-equivalent namespace when a signed YOLO lease is present, then cutovers with positive-only checks without changing that lease. The explicit `--standard-window` fallback retains the independent local confirmation. Never bypass the operator terminal requirement, signing authority, CI, rollback, or live deployment safeguards. If the installed CLI predates the change or only the operator can perform bootstrap, report the handoff rather than claiming deployment.

CLI UX direction (2026-11-17): routine terminal commands show concise results, one-line errors and actionable warnings by default. `--verbose` preserves diagnostics, `--json` preserves machine-readable behavior, and authenticated update job receipts remain in systemd journals. Private, on-demand CLI events are kept in `~/.local/state/bridge-dev/private-cli/events.jsonl`. Never log secrets or hide independent operator confirmation; do not create resident logging services.

Managed upstream provider permissions (2026-11-17): `PolicyGate.getProxyPermissions` merges **only** enabled/reviewed provider tool classifications when the runtime's effective mode is verified YOLO; STRICT/STANDARD continue using the independent operator's static policy. See `docs/POLICY_GATEWAY.md` and the isolated test `scripts/test-managed-yolo-proxy-permissions.mjs`. Never interpret this as granting an upstream subprocess host root or allowing unreviewed provider installation. The active REA configuration has three R-class tools despite an outstanding 190-tool proposal. The schema-guard repair accepts 249 tool schemas in REA 6.9.0; the existing 190-tool proposal will not automatically upgrade. After a verified release, an operator must independently approve a newly tested 249-tool proposal and the five personal skill requests. Do not approve via MCP, simulate local terminal input, or claim production access without verifying the live allowlist and client discovery.

A source-repository rename **does not rename or restart** an already-installed production service. Existing installations may still use `local-coder` paths, `LOCAL_CODER_*` environment keys, original systemd unit names and connector IDs for backward compatibility.

The privileged operator CLI, root-owned policy and Ed25519 signing key, append-only ledger and immutable code must be installed by an independent operator under a restricted service account. Do not install from an agent tool call or bypass production preflight.

See `docs/POLICY_GATEWAY.md` for the model and `README.md` for repository layout. Never commit live tokens, OAuth credentials, key material, private audit trails, or host-specific service environment files.

## Operations

- STRICT: operator-signed approval for writes/exec; sudo forbidden.
- STANDARD: scoped development with signed approval for privileged or destructive requests.
- YOLO: independently operator-signed host-root lease, indefinite until manually disabled by default or explicitly time-limited; never silently authorized or reauthorized.

A rollout of the BridgeDev **name** into live service paths or public connector names requires its own verified rollout and rollback procedure; preserve the legacy fallback until then.

## Reviewed extensions and platform verification (2026-11-13)

The main branch now includes bounded Git/HTTPS/local/archive/package discovery,
operator-reviewed scoped content/packs, deny-by-default aggregation and authenticated
CLI/admin/MCP proposal interfaces. `docs/SOURCES.md`, `docs/EXTENSIONS.md` and
`docs/MCP_INTEGRATIONS.md` define the implemented formats and restrictions.

Run `pnpm run test:all` for the complete isolated host suite; `test:extensions` and
`test:sources` are focused portable/source suites. Native Windows/macOS and Debian,
Fedora/Arch jobs passed at 4f6cf9e; later SHAs need their own CI verification. Windows
crash cleanup was accepted with PowerShell 7, not the legacy-host fallback.

Product completion remains partial: SSH/private Git adapters, general package
resolver/native wheels, community registry search, OS keychain integration and
referenced/regex provider schemas are unimplemented. Android hardware and real
ChatGPT/Codex/Claude account acceptance are unverified. No production rollout was
performed; installed service code, credentials, Funnel and workstation state remain
outside this repository task. Preserve those boundaries and the Go archive.

## Production integration fixes (2026-11-14, f909c32 cutover verified)

Isolated source work starts at d7025dd; the original checkout's local edits remain
untouched. See docs/PRODUCTION_INTEGRATION_FIXES.md for baseline, proven legacy
shape/session boundary, regression evidence and approval-required cutover/rollback.
That cutover was subsequently verified at f909c32. Per-session context remains the
default; explicit short-lived context capabilities now support stateless calls.
Never share grants implicitly by bearer token, IP or client name. Registry legacy compatibility is read-only;
only explicit operator `mcp migrate` persists a verified backup and atomic conversion.

## Optional host controller work

See docs/HOST_CONTROLLER.md. Source tests use synthetic keys and unprivileged
transaction copies; no test runner installs or calls the host helper. Deployment
and actual root verification require an independent operator bootstrap/lease.
Unrestricted host root can modify local enforcement/signing keys: do not claim a
tamper-proof lease or automatic undo of arbitrary root changes. Preserve normal
STRICT/STANDARD checks and report real ChatGPT acceptance separately.

## Versioned deployment acceptance

See scripts/deploy-acceptance/README.md and docs/DEPLOYMENT.md. Acceptance fixtures
now have explicit modes and actual service-namespace/UID preflight; root rehearsal
uses synthetic state and tests inaccessible files/parents before positive MCP
acceptance. Skill/file/document permission errors are sanitized and fail closed.
Local and CI results must be checked on the final SHA; source changes alone do not
prove deployment or real ChatGPT account acceptance.
