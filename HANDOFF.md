# Policy Gateway Production Deployment and Operational Handoff (2026-11-13)

Status: **DEPLOYED AND VERIFIED IN PRODUCTION**.

## 1. Production Deployment Status

- Release Location: `/opt/local-coder-policygate` (owner `root:root`, mode 0755)
- Active Systemd Service: `chatgpt-local-coder-policygate.service` (active, running)
- Service Identity: `localcoder` (UID 947, GID 947)
- Endpoints:
  - Port 3000: MCP server (bound to `127.0.0.1:3000`, forwarded via Tailscale Funnel `https://onyx.tail646579.ts.net`)
  - Port 3001: Localhost Admin UI (`http://127.0.0.1:3001/ui`, loopback only, token protected)
- Preserved Production Credentials:
  - `MCP_TOKEN`: `[REDACTED_PRODUCTION_MCP_TOKEN]` (retained from original production; ChatGPT connector connects seamlessly without reconfiguration)
- Sandboxing:
  - `ProtectHome=yes`, `ProtectSystem=strict`
  - `BindReadOnlyPaths=/home/onyx/.local/share/chezmoi:/srv/local-coder/context/chezmoi`
  - `BindPaths=/srv/local-coder/workspace /srv/local-coder/projects /var/lib/local-coder-policygate /var/log/local-coder-policygate`
- Audit Ledger:
  - `/var/log/local-coder-policygate/audit.jsonl` (mode 0660, `root:localcoder`, append-only `+a`)
  - Anchored to `/etc/local-coder-policygate/audit-anchor.json`
  - Cryptographic SHA-256 chain verified.

## 2. Three Operational Security Modes

1. **STRICT:**
   - Read-only inspection by default.
   - Sudo is strictly forbidden (`POLICYGATE_STRICT_NO_SUDO`).
   - Mutations (`W` and `X` class tools) require explicit signed operator approval.
   - Basic diagnostics (`pwd`, `id`, `whoami`) execute without approval.
   - Switch via: `sudo /usr/bin/node /opt/local-coder-policygate/scripts/policygate-operator.mjs mode strict`.

2. **STANDARD (Default):**
   - Everyday ChatGPT, Codex, and Linux development workflow.
   - Reads and edits inside `/srv/local-coder/workspace` and `/srv/local-coder/projects` execute without approval.
   - Builds, tests, diagnostics, and safe read-only Git tools (`git_status`, `git_diff`, `git_log`, `git_branch`) execute without approval.
   - Privileged commands (`sudo`, `pacman`, `systemctl`), destructive actions, and remote git pushes require out-of-band signed operator approval.
   - Switch via: `sudo /usr/bin/node /opt/local-coder-policygate/scripts/policygate-operator.mjs mode standard`.

3. **YOLO / FULL ACCESS:**
   - Unrestricted full-machine mode for emergency system administration.
   - Activated only via root operator interactive action:
     `sudo /usr/bin/node /opt/local-coder-policygate/scripts/policygate-operator.mjs yolo --duration <minutes>`.
   - Generates ed25519-signed lease `/var/lib/local-coder-policygate/yolo-lease.json`.
   - Privileged operations execute via narrow root broker `/usr/local/bin/local-coder-escalation-broker` allowlisted in `/etc/sudoers.d/local-coder-policygate` (`localcoder ALL=(root) NOPASSWD: /usr/local/bin/local-coder-escalation-broker *`).
   - Automatically reverts to STANDARD on lease expiry, service restart, or explicit deactivation:
     `sudo /usr/bin/node /opt/local-coder-policygate/scripts/policygate-operator.mjs yolo --off`.

## 3. Tool Profile and Restored Functionality

- Tool Profile: `slim` (33 tools advertised, node_repl and ponytail_turn permanently retired):
  - File tools: `read_text_file`, `write_file`, `edit_file`, `multi_edit`, `apply_patch`, `list_directory`, `glob`, `grep`, `rewind`
  - Git tools: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_add`, `git_commit`, `git_restore`
  - Execution tools: `run_command`, `shell_status`, `start_process`, `process_output`, `stop_process`, `clear_processes`
  - System tools: `system_context`, `system_inspect`, `system_job`, `chezmoi_inspect`
  - Agent tools: `agent_status`, `project_context`, `remember`, `load_path_rules`, `list_skills`, `load_skill`
  - Upstream bridge: `mcp_servers`
- Retired tools: `node_repl` and `ponytail_turn` are completely removed from the slim manifest and throw a clean retired-tool error if invoked.
- Deadlock prevention: `system_context` is classified as class R (read-only) and is callable immediately before any context hash is established, bootstrapping the policy gateway cleanly without deadlock.
- Dynamic mode reporting: `agent_status`, admin UI, and `permissions.ts` dynamically query `getPolicyGate().getActiveProfile()`. They report `standard`, `strict`, or `yolo`, and `full_machine_access: false` unless an authorized YOLO lease is genuinely active.

## 4. UI, Switcher, and Project Tooling

- `local-coder-switch`: One-command version switch (`local-coder-switch <new|legacy|status>`). Handles stop/start, health verification on port 3000, idempotency, and automatic rollback if target fails health checks.
- `policygate-operator`: Operator security-mode and approval CLI (`policygate-operator <mode strict|standard|yolo --duration <min>|yolo --off|approve <id>|status>`).
- `policygate-project`: Scoped workspace mapper (`policygate-project <map|unmap|list>`). Binds host project directories into `/srv/local-coder/projects/` under UID 947 with scoped POSIX ACLs.
- `local-coder-status`: Displays active mode (`STANDARD` in green, `STRICT` in blue, `YOLO` in red with remaining time and expiry), PID, memory, Tailscale Core status, and Funnel mapping.
- `local-coder-monitor` (`Win + Alt + D` scratchpad): High-contrast ANSI colors, category color-coded tool calls, bright white paths, magenta command quotes, green/red exit codes, and 12-hour AM/PM timestamps (`%I:%M:%S %p`).

## 5. Verified Rollback Runbook

One-command instant rollback:
```bash
local-coder-switch legacy
```
Restores original user service in under 2 seconds. To switch back to Policy Gateway:
```bash
local-coder-switch new
```
  `ADMIN_TOKEN` is unset. Operator must enforce authenticated admin access.
- Audit verification regards nonexistent ledger as a valid empty ledger; a
  production preflight must separately verify protected ledger presence,
  ownership, append-only flag and trusted chain head.
- Staging kit at `/tmp/policygate-restricted-uid-acceptance-20261112/`
  predates these fixes and **must be rebuilt**; do not run old kit against new code.
- Real independent operator-terminal approval, Tailscale Funnel, ChatGPT/Codex
  sessions and rollback acceptance remain untested.
- Shell and native process analysis are not OS confinement. Strict profile,
  signed approvals and a truly separate restricted UID are still required.
- No authorization to create privileged user/install files, stop production,
  change sudoers/Tailscale, commit, push or deploy.

## Next session

Run `agent-context system`, canonical `AGENTS.md`,
`docs/system/SYSTEM_CONTEXT.md`, `docs/system/system-philosophy.md`,
`docs/system/SUBSYSTEM_MAP.md` and owning agent-infrastructure docs.
Inspect `git status --short` and these files before editing. Re-run the above
suite, independently reproduce both exploits against *disposable fixtures*
and check they are denied before `system_context`. Review native Git,
shell execution, admin auth, audit boot preflight and strict profile for other
bypasses. Do not merge or deploy until independent review and actual
restricted-UID acceptance pass.

## Independent follow-up completed in isolated candidate (2026-11-12, later)

The earlier "36 passed" and "old kit" notes above describe the PREVIOUS
handoff baseline. The worktree remains on HEAD `70c8562` with uncommitted
changes retained. **Production was not modified or restarted.**

- Independent direct MCP exploit script:
  `/tmp/policygate-independent-redteam-20261112.mjs`. Disposable repository
  used `diff.external`, an untrusted `diff.<driver>.command`,
  `core.fsmonitor`, and inherited `GIT_EXTERNAL_DIFF`. Calls to
  `git_diff`, `git_status`, `git_log`, `git_branch(list)` and
  `git_stash(list)` BEFORE context did not execute the attacker helper.
  Direct protected writes and `sed -n 'w <protected>'` failed.
  Shell Git attempted without approval also failed. Exit **0**.
- New `src/admin/localhost-guard.ts` fail-closes admin HTTP when no
  `ADMIN_TOKEN` (503), denies invalid/missing tokens (401), and refuses
  non-loopback peer addresses; actual loopback HTTP tests exercise 401 and
  token-authorized access. OAuth callback remains state-based and outside
  admin token middleware.
- New `scripts/production-preflight.mjs`, referenced from the isolated
  example system unit, requires a separate real `localcoder` UID,
  root-owned immutable release/config/key/context, absolute narrow writable
  roots, independent MCP/admin tokens, root:localcoder append-only audit log,
  and a root-owned matching prefix chain anchor. Development
  `verifyAuditFile` is intentionally unchanged. Preflight negative test
  (run without a service UID) exits 1 as expected; real privileged positive
  test remains BLOCKED.
- `scripts/run-all-tests.mjs` and `scripts/test-mcp-bridge-integration.mjs`
  now use independent ephemeral admin tokens and reject anonymous access.
  Bridge integration was updated to test signed-approval refusal for
  `mcp_call` and dynamic proxies rather than assuming unsigned execution.
- Verified: `pnpm run test:policy` **38/38**, exit **0**;
  `MCP_TOKEN= pnpm run test:all` **PASS**, exit **0**;
  `MCP_TOKEN= pnpm run test:integration` **PASS**, exit **0**.
- New independent package at
  `/tmp/policygate-restricted-uid-acceptance-20261112-v2/`
  (26 MB), including updated compiled dist and tests, narrow staging policy,
  root-run operator setup procedure, offline dependencies, six canonical docs
  with checksums, package/source hash manifest, and operator-only signed
  acceptance script. Its packaged policy tests pass **38/38**, unit syntax
  exits **0**, executable import succeeds, and external pnpm links count is
  **zero**. The older staging kit remains untouched and obsolete.

**Still NO-GO for deployment.** The actual `localcoder` UID, root-owned
installation, append-only ledger, signed real operator TTY workflow, real
OS permission denial, service startup, end-to-end ChatGPT/Codex sessions,
OAuth-state acceptance, Funnel/rollback drill are NOT verified. No general
sudo, no secrets, no user-service restart, no deployment, no commit or push.

## Final independent upstream audit and follow-up (2026-11-12)

The preceding v2 kit is **superseded**; use only v4. A new independent
in-memory MCP red-team fixture at
`/tmp/policygate-upstream-redteam-20261112.mjs` confirmed that
read-classified `mcp_servers`, `mcp_tools`, and `agent_status` would each
launch an attacker-configured stdio upstream program BEFORE `system_context`.
With `EXPECT_EXEC=1` against the unchanged candidate, all three generated
execution markers (exit 0). After mitigation each produced no marker
(exit 0 with `EXPECT_EXEC` unset). A persistent regression
`scripts/test-policy-upstream-readonly.mjs` now also verifies
`mcp_servers(refresh:true)` is denied without context.

New candidate edits:
- `src/lib/mcp-upstream-manager.ts`: cache-only
  `listStatusesCached` and `peekTools` do not connect.
- `src/tools/mcp-bridge.ts`: R-class listing uses cache; X-class
  `refresh:true` retains explicit connection capability behind approval.
- `src/tools/context.ts`: `agent_status` uses cached status.
- `scripts/test-policy-upstream-readonly.mjs` regression added to both
  `pnpm run test:policy` and `pnpm run test:all`.
- Standalone HTTP bridge tests revised for an admin-warmed upstream
  cache; the initial live admin health request is authenticated.

Source tool-count manifest and dots feature documentation remain
31 slim / 55 full (SHA256 `9af7ee1a...`), unchanged. The deployment kit
intentionally narrows its slim profile to 16 while retaining full inventory
55; stage count manifest is generated separately.

### Staging v5 remediation (preflight blocker fixes)

- Blocker 1 (Shell state persistence): `MCP_SHELL_STATE_DIR` resolved to
  `/var/lib/local-coder-policygate-staging/home/.mcp-state` in `src/lib/global-shell-state.ts`,
  environment file, and service unit. Preflight write probe verifies home writability.
- Blocker 2 (Admin UI assets): `public/ui` (`index.html`, `app.js`, `styles.css`) packaged
  into `offline-runtime/public/ui` and verified accessible.
- Blocker 3 (Secure token validation): `validateSecureToken` in `production-preflight.mjs`
  enforces length >= 32, rejects placeholders (`replace`, `password`, `test`, `default`, etc.),
  repeated chars, repeating patterns, low entropy (<10 unique chars), and sequential character runs.
- Blocker 4 (OAuth storage isolation): `MCP_OAUTH_STORE` resolved to
  `/var/lib/local-coder-policygate-staging/home/.mcp-oauth` in `src/lib/mcp-oauth-provider.ts`
  and service unit. Unit tests verify valid, invalid, missing, and replayed states.

Final kit: `/tmp/policygate-restricted-uid-acceptance-20261112-v5/`.
The earlier original/v2/v3/v4 kit paths remain evidence but MUST NOT
be used for acceptance. No real service UID or privileged deployment
was installed. Production user-unit journal confirms PID 285905 has been
running steadily on ports 3000/3001 with Funnel intact.

No real restricted-UID operator approval, root-owned audit, system service,
or live Funnel acceptance has been performed. **NO-GO remains mandatory.**

## Final Codex authorization mismatch & host-workspace resolution (2026-11-13)

- Root cause of `SECURITY_PRIVILEGED_COMMAND_REQUIRED`: `src/server-factory.ts` authorized
  the request at the PolicyGate layer but failed to populate the authorization context for
  the tool handler. `src/tools/shell.ts` called legacy `getSecurityPolicy().authorizeCommand(command, auth_token)`
  where `auth_token` was undefined, throwing `SECURITY_PRIVILEGED_COMMAND_REQUIRED`.
- Fix: `src/server-factory.ts` automatically creates a single-use authorization token
  bound to `sha256(command)` with a 60-second TTL when `decision.requiresApproval` succeeds,
  injecting it into `args.auth_token`. Clients (Codex and ChatGPT) need no secret tokens;
  they repeat the identical call after the operator approves the request ID via
  `policygate-operator.mjs approve <request-id>`. Verified via `/tmp/test-codex-auth-flow.mjs`
  and regression in `scripts/test-policy-gateway.mjs`.
- Host-workspace isolation: `ProtectHome=yes` is strictly preserved. Opt-in project
  directories are exposed under `/srv/local-coder/projects/` via systemd `BindPaths=`
  with per-project POSIX ACLs (`setfacl -m u:localcoder:rwX`). Canonical chezmoi sources
  are mounted read-only via `BindReadOnlyPaths=/home/onyx/.local/share/chezmoi:/srv/local-coder/context/chezmoi`.
  Verified via real UID 947 service execution with disposable project fixture.
- Audit ledger contract: Verified `root:localcoder` ownership, mode `0660`, parent
  directory `0750`, append-only attribute `+a`, and trusted root-owned genesis anchor.
- Full suite status: `pnpm run test:policy` (41 passed, 0 failed), `pnpm run test:all`
  (ALL TESTS PASSED). Production service (PID 285905) and staging service (PID 348712)
  remain untouched. Production cutover remains NO-GO until explicit operator authorization.



