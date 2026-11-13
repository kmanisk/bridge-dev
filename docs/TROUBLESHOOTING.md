# Troubleshooting

## Startup and authentication

Run `bridge-dev doctor` with the same `.env`, workspace and selected ports as serve.
Portable diagnostics inspect the application and never require a Linux system
service or production audit anchor. Managed diagnostics may report protected state
as UNVERIFIED; inspect it from an independent operator terminal.

The gateway requires generated URL-safe tokens of at least 32 characters. `/mcp` accepts `Authorization: Bearer
<token>`. Legacy `/mcp/<token>` URLs remain compatible; keep them out of logs,
screenshots and public issues. `/` without a secret is not an anonymous MCP route.
MCP and admin tokens must differ. The loopback admin login shell is public static
content; its API requires the independent admin token. Refresh after entering it.

`EADDRINUSE` means a selected port is occupied. Pick different `PORT`/`ADMIN_PORT`
values; do not stop an existing production gateway to run a test. Portable mode
refuses non-loopback binds. Configure remote HTTPS separately with the operator;
never publish the admin listener.

## Extensions

- `SOURCE_AMBIGUOUS`: no reliable component definition was found. Use a compatible MCP manifest/export or a valid skill, and select candidates explicitly. README commands are never installers.
- `SOURCE_SSH_UNSUPPORTED`: use public HTTPS Git or a reviewed local checkout. SSH/private credential adapters are not implemented.
- `PACKAGE_DEPENDENCIES_REQUIRE_REVIEW`: automatic dependency resolution is unavailable. Install dependencies independently and import a local MCP definition.
- `SKILL_REFERENCE_MISSING`: use a repository/archive containing the complete skill; a raw file cannot supply missing relative references.
- `PROPOSAL_STALE` / `PROVIDER_PROPOSAL_STALE`: inspect current state and create a new proposal. Old approval does not authorize changed code/configuration.
- `CONFIG_BUSY`: another operation holds an exclusive lock. Check that process before manually recovering stale lock directories.
- Invalid optional registry/content: the core starts with the rejected module unavailable and reports its error. Inspect the private `.bak` snapshot; never silently overwrite corrupted configuration or restore an unreviewed file.
- Provider registered but no tools: registered, enabled, connected and exposed are separate states. Test as an operator, review exact tools/permissions and approve enabling.
- `STRICT_PROVIDER_REFUSED`: stdio is refused in strict mode. Use a reviewed HTTP provider or the appropriate separately isolated deployment.
- Unsupported provider schema: referenced and regex schemas currently fail closed. Do not remove validation to expose them.

`mcp logs` shows bounded redacted provider diagnostics. A failed provider must not
break native gateway tools. After disable/remove, stale manifests cannot authorize
calls. Clients that cache tools may require reconnecting or a new chat even after
tool-list notifications were sent.

## Policy and cleanup

`POLICYGATE_CONTEXT_REQUIRED` means the session needs `system_context` before a
mutation/executable. Managed signed approvals remain out-of-band; neither an MCP
client nor a skill can sign itself. Use the independently installed operator CLI
for managed privileged requests. Portable mode has no root-privilege lease.

Windows crash cleanup requires the native snapshot helper and a working PowerShell
host. PowerShell 7 passed native CI; legacy-host fallback remains unverified. A
cleanup error is reported and disablement still takes effect before teardown.
Containers need a real init (`--init`) to reap terminated orphan processes.

## Verification and rollback

`pnpm run test:all` runs baseline and new scenarios under disposable HOME/XDG,
configuration, credential and audit state. Host-specific tests require their actual
local validators. `test:extensions` and `test:sources` run focused fixture scenarios.
Optional UI QA: `BRIDGEDEV_TEST_BROWSER=/absolute/path/to/chromium pnpm run test:browser`.
No tests should point at production ports or state.

Configuration backups are private inert snapshots. Stop the affected disposable
instance, inspect differences and restore only the reviewed scope. Managed service
rollback is an independent operator procedure described in deployment documentation;
repository operations never stop or switch live services automatically.
