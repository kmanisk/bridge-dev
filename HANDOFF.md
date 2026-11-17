# BridgeDev — repository handoff

## Shadow-update implementation work (2026-11-17)

The current feature branch adds isolated bubblewrap acceptance and protects
the existing root-signed lease fingerprint across service cutover; the
transient job uses a verified staged release without a second `gh` fetch.
Default YOLO path is intended to require no mode transition, but the original
`--standard-window` safety path remains. Source and CI acceptance do **not**
prove local systemd/bubblewrap compatibility, Funnel isolation on the user's
host, or successful production cutover. Do not merge or deploy until those
independent security checks pass. No live service, lease, credential, policy,
or hardening has been changed.



BridgeDev is the TypeScript/Node.js MCP development gateway with signed operator approvals and a restricted OS deployment model. This repository **replaces the historical Go prototype**; its source remains accessible in Git history, not in the current working tree.

## Source and verification

- Canonical code: `https://github.com/kmanisk/bridge-dev`, branch `main`.
- Build and test: `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build`, `pnpm run test:policy`, `pnpm run test:all`.
- GitHub Actions `policy-tests` additionally verifies the registered MCP tool inventory against `profiles/native-tool-counts.json`.
- Retain the upstream MIT license and copyright in `LICENSE`.

## Deployment boundary

Owner workflow preference (2026-11-17): after explicitly requested BridgeDev product or UI changes, complete verified CI and pursue the guarded live deployment, not merely a local source commit. Verify and report whether the running gateway actually picked up the release. `bridge-dev update` is the single local command: stage and verify before a temporary STANDARD maintenance window; run tracked acceptance; restore an existing indefinite YOLO lease only after independent local confirmation. Never bypass the operator terminal requirement, root authorization, CI, or rollback. If the operator-only step cannot run through MCP, report the exact handoff instead of claiming deployment.

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
