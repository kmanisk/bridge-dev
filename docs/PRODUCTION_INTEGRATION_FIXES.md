# Production integration fixes and pending cutover

## Evidence and baseline (2026-11-14)

Source baseline: d7025dd29e8186f4456e3fb1da3d27df7e25495a. `pnpm run build` and
`pnpm run test:all` passed before edits in an isolated main checkout. The original
checkout's dirty package.json and two untracked trial scripts were preserved.
No dependencies were added. No production request, restart, migration or cutover
was performed; production inspection was read-only.

Production unit: chatgpt-local-coder-policygate.service, restricted localcoder
account, /opt/bridge-dev/dist/index.js, ProtectHome=yes, ProtectSystem=strict.
The older /opt/local-coder-policygate release remains available. The verified
registry is /etc/local-coder-policygate/mcp-upstream.json: 20 bytes, root:root,
mode 0644, `servers:[]` and no version field. There are zero configured providers;
that is not evidence of provider loss. Current source previously refused this
exact shape with Unsupported upstream schema version.

The context call at 18:57:41 UTC succeeded under one policy-session ID; the command
at 18:58:23 UTC was denied under a different ID. Neighboring inspection calls also
used distinct policy sessions. This establishes a session boundary, not an
in-session hash comparison failure. Policy sessions are closure-bound to the server
created by buildSession; recovery builds a new policy session. Missing HTTP session
headers trigger independent adoption on every request. That response previously
omitted Mcp-Session-Id. Context uses file bytes, not timestamps or system inspection
output; repeated live read-only digest samples were stable. The successful native
result shape reaches contextLoaded; a real HTTP client retaining its session can
load context and execute pwd.

The regression also fails against unmodified d7025dd: restoring old context bytes
incorrectly reactivated an old grant. The fix clears stale grants. Failed document
loads previously could grant authorization from a later reread; the fix binds the
native loader's actual documents/digests and refuses missing or changed inputs.
DELETE and expired-session access now revoke grants before reuse. Tests exercise
initialization, reconnect, headerless adoption, invalidation, expiry, signed/strict
boundaries and audit correlation through real HTTP clients.

One full-suite rerun encountered a Python venv codec initialization failure in the
unchanged source fixture. Baseline had passed; the system interpreter's encodings
module and the focused source fixture subsequently passed without changes or skips.
The subsequent full suite passed without changing or skipping source tests. All
eight requested build/test commands passed; the full suite includes 26 isolated
script groups plus inventory. Exact-head CI is reported with the publication.

## Remaining client boundary

Retaining a session is mandatory for context followed by execution. Publishing an
adopted session ID and exposing it to browser clients makes recovery usable; it does
not make a client retain it. No client/account transport configuration was changed.
If the new ChatGPT connector keeps opening unrelated sessions, it must retain the
MCP session header. Shared bearer credentials, client names, IP or User-Agent are
not a safe substitute. Actual ChatGPT acceptance remains a cutover gate; isolated
client success must not be reported as production connector success.

## Approval-required production procedure

This is a plan, not an executed deployment. Use the final published, CI-green SHA
from the completion report as RELEASE_SHA. Stage at
`/opt/bridge-dev-releases/<RELEASE_SHA>`. Keep the existing d7025dd directory at
`/opt/bridge-dev-releases/d7025dd-pre-cutover-<UTC timestamp>` after stopping the
service. Do not move or overwrite /opt/local-coder-policygate.

1. Recheck service PID/user, sandbox, active/enabled state, existing unit and env
   paths, disk space and current root snapshot policy. Record original code,
   registry digest, owner/mode, unit digest and read-only audit-chain/anchor status.
   Verify operator key permissions without printing key bytes. If a pre-change
   Snapper snapshot is required, create it only after approval. Abort before
   stopping on any mismatch, failed CI, changed registry or insufficient rollback
   space. No package installation, new service or Funnel change is required.
2. Copy only the reviewed source/build, existing lockfile dependencies and required
   platform/public/scripts assets into the staging release. Verify its SHA and
   content manifest. Make code root-owned, readable by localcoder and unwritable
   by the service. Build/tests already run outside production; do not point a test
   suite at service.env, production state or ledger. Verify staged code's managed
   startup using disposable fixture policy/ports, never production credentials.
3. As the independent operator, run the staged migration CLI in a clean temporary
   HOME with dotenv disabled. First inspect the dry-run below. Applying requires
   separate approval for this plan; record returned backup path and SHA-256. For
   the currently verified empty legacy file the sole semantic change is
   `[{"op":"add","path":"/version","value":1}]`. If the file changed, abort and
   obtain a fresh review. Migration must preserve the original root:root/0644
   ownership/mode and must not touch credentials, operator keys or ledger.

   ```sh
   sudo /usr/bin/node /opt/bridge-dev-releases/<RELEASE_SHA>/dist/cli.js mcp migrate \
     --config /etc/local-coder-policygate/mcp-upstream.json --dry-run --json
   sudo /usr/bin/node /opt/bridge-dev-releases/<RELEASE_SHA>/dist/cli.js mcp migrate \
     --config /etc/local-coder-policygate/mcp-upstream.json --json
   ```

4. Stop only chatgpt-local-coder-policygate.service. Rename its existing
   /opt/bridge-dev directory to the rollback path above. Atomically install a
   root-owned /opt/bridge-dev symlink to the staged release (create a temporary
   sibling symlink, then rename). The existing unit/credentials/ports stay intact;
   no daemon-reload is required if the unit is unchanged. Start the same unit.
5. Within 30 seconds verify active state, localcoder UID/GID, unchanged sandbox,
   loopback-only 3000/3001 listeners, health JSON, startup logs and readable state.
   Verify Admin API authentication isolation: MCP credentials cannot access admin.
   Load tokens only from the protected env file into the operator acceptance
   process's memory; never print tokens, place them on command lines or save them
   into fixtures. Do not change Tailscale/Funnel or the public connector URL.
6. Within 120 seconds run an independent MCP SDK HTTP acceptance client: initialize;
   pwd before context denied; agents/current_state loaded; pwd succeeds in the same
   session; a second client denied without context; sudo id denied without approval;
   mcp_list/mcp_status have no initialization error and report version 1. The actual
   empty registry should report zero providers. mcp_info must give provider-not-found
   for an unknown name, not a schema error. No mock provider is added to production.
   Verify audit grant/deny records and chain/anchor invariants without truncation.
7. Exercise the existing ChatGPT connector with context then pwd in the same session,
   and confirm read-only tools still work. If it drops session IDs, do not share
   grants or weaken policy to pass acceptance. Treat that as a failed cutover gate.
   Require connector confirmation within the acceptance window; otherwise roll back.
8. Only after all acceptance gates pass, update canonical chezmoi deployment/system
   documentation and changelog with verified SHA, paths, health and rollback state.
   Keep both rollback releases. Never describe this pending plan as deployed.

## Automatic rollback contract

The operator cutover controller must arm rollback before stopping the service and
invoke it on any failed preflight after mutation, start/health/authentication/audit
check, MCP acceptance, connector acceptance or timeout. Use an exit/error trap and
a bounded acceptance deadline; disarm only after all gates pass.

Rollback stops the same unit, moves aside only the new /opt/bridge-dev symlink,
restores the recorded d7025dd directory to /opt/bridge-dev, verifies and atomically
restores the migration backup with its original owner/mode, then starts the same
restricted unit. Never restore/truncate the append-only ledger, rotate keys/tokens,
change mode or switch to an unrestricted user service. Recheck health, original
sandbox/UID, token URL compatibility and ledger integrity. Keep the failed staged
release and bounded redacted diagnostics for investigation. If rollback health
fails, stop further changes and report the exact blocker; the retained
/opt/local-coder-policygate release is available for a separately reviewed recovery.
