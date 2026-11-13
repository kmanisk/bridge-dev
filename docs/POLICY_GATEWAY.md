# Policy Gateway — experimental worktree implementation

Status: **development only**. The production Local Coder process, token, Tailscale
Funnel, service units, sudoers and accepted chezmoi documentation remain untouched.
Do not deploy until tests and human acceptance are complete.

## Server-enforced mechanisms

- Every native and dynamically registered MCP handler passes through the
  `server.registerTool` authorization wrapper. Unknown native registrations
  fail; proxy tools require a signed out-of-band approval by default.
- Per-session context gate requires a successful `system_context` call loading
  the canonical `AGENTS.md` and `SYSTEM_CONTEXT.md` before write/exec.
  Changing either document invalidates that session's authorization.
- JSON configuration validates all top-level keys and limits. A dedicated
  operator must install the config as root-owned; the example alone is not
  a production trust boundary.
- File checks canonicalize `..`, existing symlinks and parent components and
  reject dangling links. The checks apply to native read/write tools, Git repo
  targets, rewind restore targets, multi-file patch operands, and named files.
  An edit of a chezmoi-managed target additionally checks its redirected
  canonical source against writable roots, protected paths and hard paths.
  Recursive search implementations skip configured secret names/segments.
- Shell analysis recognizes many common command separators, redirections,
  wrappers, nested shell commands, substitutions, glob prefixes, and common
  destructive or privileged commands. Dangerous patterns are denied. In
  strict and standard modes, every shell command except the exact diagnostic
  `pwd`, `id`, or `whoami` requires signed out-of-band approval (policy-specific
  approval rules can also restrict those diagnostics). Shell `sed` is denied,
  including without `-i`, because `w`/`e` scripts can write or execute. Shell
  `rg` and `find` are denied; use filtered native search tools. Git CLI
  commands require approval because read-looking Git operations can execute
  repository-configured helpers.
- A root-only Ed25519 operator signing flow is provided. The server can read
  only the operator's public key, never the private key. Approval signatures
  are bound to the session and full tool arguments, time-limited and
  single-use; a denied request must be repeated identically after approval.
  The operator CLI recomputes the request fingerprint from its tool and exact
  arguments before presenting or signing anything, rejecting spool tampering.
- Denial lockout, payload and per-minute mutation limits are session scoped.
- Before running each registered handler, its decision is durably appended to
  a SHA-256 chained JSONL ledger (with `fsync`). Read/append verification
  failures deny execution. Result entries are appended afterward. Secret-like
  fields are redacted in the ledger.
- Native `git_diff` runs with `--no-ext-diff --no-textconv`; native Git read
  calls clear inherited `GIT_*` environment and disable fsmonitor and optional
  locking. A real MCP regression verifies untrusted external diff/fsmonitor
  helpers do not execute before `system_context`.
- The independent red-team review also reproduced a THIRD pre-context execution
  bypass: read-classified `mcp_servers`, `mcp_tools`, and `agent_status`
  connected to configured stdio upstream MCP providers and launched arbitrary
  executables. These paths now use cached status and tools without connecting;
  explicit `mcp_servers(refresh:true)` is X-class and requires context and
  a signed operator approval. `scripts/test-policy-upstream-readonly.mjs`
  proves no marker executes and refresh is rejected pre-context.
- Local admin HTTP rejects live changes to `POLICYGATE_*` and other sensitive
  environment keys. The candidate now **fails closed** with HTTP 503 when
  `ADMIN_TOKEN` is absent and HTTP 401 when it is invalid; the full HTTP suite
  verifies unauthenticated denial and authenticated access. OAuth callbacks
  remain exempt from the token and require their separate per-flow state.
  Loopback binding and authentication do not replace OS isolation.

## Known independent audit findings and remaining blockers (2026-11-12)

An independent audit reproduced two failures against the earlier candidate
commit `70c8562`: a protected-file overwrite through `sed`'s `w` directive,
and execution of an untrusted external Git diff driver through native
`git_diff` before context bootstrap. The isolated feature worktree now has
mitigations and real MCP regression tests. An independently written, disposable
MCP fixture verified that `sed` could not overwrite a protected sentinel,
native `git_diff`, `git_status`, `git_log`, branch/stash list did not
execute external Git helpers even before context, and shell Git commands
required signed approval. The extended policy suite passed 38/38, the full
suite passed, and standalone bridge integration passed with explicit
context/approval refusals. **This is not host-level acceptance.**

Production remains the original unrestricted user service, not this candidate.
The rebuilt and verified kit is
`/tmp/policygate-restricted-uid-acceptance-20261112-v5/`, compiled from the
current uncommitted feature worktree with a self-contained pnpm dependency
tree (zero symlinks outside the release), a recorded build manifest, six
hashed canonical context snapshots, and an isolated staging systemd unit.
The earlier kits (original, v2, v3, v4) predate some mitigations and must not
be used. The source proposal manifest reflects 31 slim/55 full tools,
while the isolated staging tool override deliberately exposes only 16 slim
tools; its manifest is generated separately from the actual staged profile.

Preflight blockers resolved in v5:

- Shell state persistence: `MCP_SHELL_STATE_DIR` points to
  `/var/lib/local-coder-policygate-staging/home/.mcp-state` and is verified
  writable by the staging service UID.
- Admin UI assets: `public/ui` assets (`index.html`, `app.js`, `styles.css`)
  are packaged in the offline runtime and verified accessible.
- Credential entropy: `production-preflight.mjs` rejects placeholders,
  repeated characters, repeating patterns, low entropy, and sequential runs.
- OAuth storage redirection: `MCP_OAUTH_STORE` points to
  `/var/lib/local-coder-policygate-staging/home/.mcp-oauth`, and unit tests
  verify valid, invalid, missing, and replayed OAuth states.

Additional deployment blockers identified by the independent audit:

- The candidate's sensitive admin routes now deny access when `ADMIN_TOKEN`
  is unset or invalid. Independently validate the exempt OAuth callback's
  state handling and real administration-plane isolation before deployment.
- `verifyAuditFile` intentionally considers a missing log an empty valid
  ledger **for development only**. The new `scripts/production-preflight.mjs`
  is wired into the example unit and fails before startup unless the service
  is running under a distinct `localcoder` UID, executable/config/key/context
  permissions are root-controlled, tokens are independent, the existing
  audit ledger is root:service-group append-only, and its chain matches a
  root-owned trusted prefix anchor. Actual privileged host verification is
  pending; it has only been tested to fail closed without the service UID.
- There is no installed `localcoder` UID, independent immutable release,
  protected audit ledger or root operator signing key. Tests under a rootless
  namespace mapping back to login UID 1000 do not satisfy this boundary.
- The actual operator-terminal approval path, real ChatGPT/Codex connections,
  and Tailscale Funnel migration/rollback have not been accepted.

## Explicit limits

**This is NOT OS confinement.** Parsing commands is heuristic. It cannot see
code inside scripts, evaluated expressions, generated command arguments, loaded
libraries, process injection, imported modules, Git hooks, or opaque upstream
MCP plugins. A shell, REPL, package hook, Git hook, authorized proxy or graphical
tool with write access can still change files or access secrets outside the
declared paths. Symlink/TOCTOU races can occur between canonicalization and
the filesystem operation. The gateway cannot guarantee that hard paths are
immutable after arbitrary process execution, especially in dangerous mode.

Executable SessionStart Codex hooks are disabled before policy bootstrap.
Upstream discovery may still connect to an enabled external provider at session
initialization; the **MCP tool calls** are individually classified, but upstream
connection side effects are not authorized as per-session tool calls.
Disable or separately isolate untrusted upstream startup connections.

The policy path list and secret-name filters cannot cover arbitrarily computed
paths in approved dynamic code. Some built-in tools include implicit paths such
as memory/checkpoint storage and Git hook effects; the implemented implicit
paths are checked, but **indirect external executables remain a separate trust
boundary**. An operator approval is permission to run precisely the requested
MCP action, not proof that all its future subprocess effects are safe.

The approval spool is writable by the service identity unless separated by
filesystem ownership and a trusted broker. Signed tickets prevent forgery and
the server verifies stored request summaries, but an attacker with that UID
may still manipulate request metadata or attempt to mislead the operator.
Treat the root-only terminal signer and its private key as an isolated trust
boundary, review the full real command/path set, and do not store that key
under the MCP service account.

A SHA-256 hash chain detects accidental/tampered records only while a trusted
chain head or append-only OS protection is maintained. Without root-owned
append-only storage an attacker able to rewrite the entire log could recompute
the hashes. The `chattr +a` attribute depends on filesystem support.

**Do not grant the MCP service general sudo or share the login user's UID.**
The legacy unrestricted sudo policy on the existing workstation must be
removed from the MCP execution identity by a separate explicitly authorized
operator migration. No user-level instruction, JSON policy or MCP token can
substitute for this operating-system boundary. Do not enable dangerous mode
on the existing unrestricted account.

## Files and startup

- `profiles/policy.example.json`: schema and conservative development defaults.
  Configure a separate root-owned file with absolute paths for deployment.
- `POLICYGATE_POLICY_FILE=/etc/local-coder-policygate/policy.json`
- `POLICYGATE_APPROVAL_PUBLIC_KEY=/etc/local-coder-policygate/operator-public.pem`
- `POLICYGATE_APPROVAL_DIR=/var/lib/local-coder-policygate/approvals`
- `POLICYGATE_DANGEROUS=yes` AND `dangerous_enabled=true` are BOTH required
  to select dangerous mode; this does not make the mode safe.
- `pnpm run verify-audit`: verify hash chain, exit nonzero on tampering.
- `pnpm run test:policy`: disposable MCP authorization and bypass tests.
- `node scripts/sync-tool-counts.mjs --check-manifest profiles/native-tool-counts.json`:
  verify the committed inventory against real registered tool discovery.
- `node scripts/sync-tool-counts.mjs --check <dots-worktree>`:
  compare generated markers in both canonical docs, without changing them.
- `--write <dots-worktree>` updates markers only, after operator approval.

## Restricted deployment (example; DO NOT APPLY AUTOMATICALLY)

The files under `deployment/` are proposed templates. Adapt user/group, mount,
ACL, writable roots, policy and service paths to the actual host. Nothing here
has been installed, chmodded on the real machine or enabled.

1. Create a dedicated `localcoder` service user without general sudo, shell
   login or permission to change the installed server/policy. Install a built
   and reviewed release under root-owned `/opt/local-coder`.
2. Give that service account access only to explicitly approved worktrees and
   canonical system docs via narrow ACLs or read-only binds. Do not
   recursively make the user's entire home or encrypted secrets accessible.
3. Install root-owned policy at
   `/etc/local-coder-policygate/policy.json`, mode `0644` (or `0640`
   with an appropriate read-only service group), and maintain absolute
   `hard_paths` that cover all gateway code, policy, audit and admin modules.
4. Generate the Ed25519 key pair **from an operator root terminal** using
   `node scripts/policygate-operator.mjs keygen` (after reviewing its
   root-only checks). Install root-private key mode `0400`; give the
   service only the public key.
5. Create the append-only ledger and parent directory using operator-root
   commands (adapt paths and confirm filesystem support):

   ```sh
   sudo install -d -o root -g localcoder -m 0750 /var/log/local-coder-policygate
   sudo touch /var/log/local-coder-policygate/audit.jsonl
   sudo chown root:localcoder /var/log/local-coder-policygate/audit.jsonl
   sudo chmod 0660 /var/log/local-coder-policygate/audit.jsonl
   sudo chattr +a /var/log/local-coder-policygate/audit.jsonl
   sudo lsattr /var/log/local-coder-policygate/audit.jsonl
   ```

   Do not append to the ledger manually or rotate/truncate it in place.
   Copying/rotating requires a trusted operator procedure that preserves
   and anchors the previous hash chain.
6. Validate the `deployment/chatgpt-local-coder-policygate.service.example`
   unit with `systemd-analyze verify` after adapting it. Run it on demand;
   do not `enable` it. The example uses `NoNewPrivileges`,
   `ProtectSystem=strict`, restricted writable paths and a dedicated UID.
7. The fixed helper `deployment/policygate-root-helper.mjs` has only
   `status`, `start`, and `stop` verbs for one literal unit name. If
   installing it, keep it root-owned and grant NO general sudo. An optional
   scoped sudoers entry should permit **only** the `status` verb; start/stop
   remain operator-root actions outside MCP.
8. Test the effective OS identity and actual denial of root files, private
   SSH keys, protected worktrees and user-owned credentials before exposing
   the MCP endpoint to ChatGPT.

### Interactivity and virtualization

A separate service UID and `NoNewPrivileges` cannot transparently run all
applications in the active user's Wayland session. In particular, Looking Glass
clipboard FUSE, user Sway sockets, privileged libvirt/VFIO launchers, and
existing on-demand systemd user units need a dedicated, separately reviewed
broker/lifecycle. **Do not remove OS isolation to get these working.**
The CLI policy can refuse these operations until that broker exists.

## CI and documentation synchronization

The documentation count markers describe the isolated candidate build, not
what the currently running production connector exposes. Local Coder CI job
`policy-tests` runs fixture tests and verifies
`profiles/native-tool-counts.json`, generated by actual MCP tools/list
registration. In the separate dots worktree, `AGENTS.md` and
`docs/system/SYSTEM_CONTEXT.md` contain a generated marker and the
pre-commit hook checks it against a locally built Local Coder checkout.

For cross-repository CI, `kmanisk/dots` requires a read-only token
(`LOCAL_CODER_READ_TOKEN` secret) and the intended audited branch/ref
(`LOCAL_CODER_POLICY_REF` variable) to check out the private Local Coder
repository. This cannot pass until the code is published and the authorized
repo access is configured. Both source repos may have outstanding uncommitted
changes; do not overwrite them.

Suggested branch-protection command for `kmanisk/dots` (**DO NOT EXECUTE AUTOMATICALLY**):

```sh
gh api -X PUT repos/kmanisk/dots/branches/master/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["documentation-contract", "policy-tests"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

This sets both required CI contexts and includes administrators; verify the
current repository rulesets/branch restrictions before applying a PUT request,
since GitHub may replace an existing branch-protection configuration.

## Manual acceptance before deployment

- Open a fresh MCP session, verify write/exec are rejected before
  `system_context`, then succeed only within writable roots afterward.
- From a second session change a disposable context doc, verify first
  session's next mutation is rejected until context reload.
- Exercise forbidden native tools, secret scans, shell command patterns and
  admin-loopback attempts; verify each action is denied with useful guidance.
- In a separate operator terminal, inspect the approval prompt, sign exactly
  one request, and prove the identical replay succeeds only once.
- Cause five denials and verify only a root-signed operator unlock can restore
  that particular session.
- In the disposable test worktree run `pnpm run test:policy` and
  `MCP_TOKEN= pnpm run test:all`. The fixture includes real MCP tool calls
  that attempt command, path, audit, and approval bypasses.
- Check tool-count integrity via `node scripts/sync-tool-counts.mjs --check-manifest profiles/native-tool-counts.json`
  and, for the isolated dots proposal, `node scripts/sync-tool-counts.mjs --check /home/onyx/Projects/dots-policygate-sprint`.
- Verify `pnpm run verify-audit` before and after actions; tamper with an
  **isolated test ledger**, not the production append-only file.
- Run the same connector checks from fresh ChatGPT and Codex sessions, then
  separately validate operating-system permissions with the restricted UID.
- Confirm previous services, Tailscale Funnel, Nano11/Atlas, GPU bindings and
  all unrelated work remain unchanged.
