# Deployment acceptance harness

Linux root operator entry: `run.mjs`. It never signs approvals, issues leases,
changes modes, installs providers or edits production configuration. Credentials
are read from the selected protected environment file into process memory only.
The independent official SDK client validates advertised output schemas.

```sh
node scripts/deploy-acceptance/run.mjs fixtures RELEASE ENV_FILE GATEWAY_PID ROOT_PRIVATE_PLAN
node scripts/deploy-acceptance/run.mjs accept RELEASE ENV_FILE GATEWAY_PID ROOT_PRIVATE_PLAN
node scripts/deploy-acceptance/run.mjs cleanup RELEASE ENV_FILE GATEWAY_PID ROOT_PRIVATE_PLAN
```

`fixtures` creates unique content under the configured mapped workspace, checks
access through the current unit's mount namespace with its UID/GID/groups, and
writes a root-owned mode-0600 plan in a root-owned non-writable parent. `accept`
activates a dormant SKILL.md.pending file and rechecks access using the new PID
after cutover. The dormant file is preflighted before stopping production, but
is not advertised in cached startup instructions; cleanup leaves no stale fixture
skill in that startup snapshot. `cleanup` is idempotent and does
not read credentials. Root is required for the namespace/UID transition; the
checker itself has no root privileges and performs only reads of planned fixtures.

`fixtures.mjs` explicitly sets newly created shared parents to 0755, fixture
folders to 0555 and content to 0444 after creation, independent of caller umask.
Only the new fixture repository and skill directory are changed; existing parents
are never chmodded. The Git read fixture is owned by the service UID/GID; a root builder keeps the
skill content root-owned. Both are read-only to the service. Preflight
checks every file's type, owner, mode, content digest and actual readability, plus
traversal through every parent. It uses the real unit's mount namespace, including
ProtectHome, ProtectSystem, read-only/bind mounts and PrivateTmp. No unit settings
are changed. Fixtures live in the mapped workspace, never HOME or host /tmp.

`client.mjs` checks authentication, the inventory, context/pwd, privilege denial,
session/stateless isolation, all exposed read tools and admin isolation. Missing
provider/process errors are accepted only for their explicit not-configured cases;
output-schema errors always fail. `load_skill` must succeed on the exact fixture.
The sole baseline exception is the already diagnosed skills_validate array error
when root `run.mjs` is verifying restored commit f909c32; candidates get no exception.

Cleanup removes only plan-owned unique fixture directories and newly created empty
parents. The cutover controller must call cleanup on success, failure and rollback,
stop its rollback timer, remove transient units/archives, and retain receipts and
verified registry backups. Never restore/truncate the audit ledger during rollback.

`test-deploy-acceptance.mjs` runs in the mandatory isolated test wrapper. It covers
umask 0077, negative permission preflight, sanitized diagnostics and real HTTP SDK
acceptance. It runs in policy, integration and full suites. A separate explicit
root rehearsal creates a disposable gateway using synthetic config/credentials,
the source unit's service user, UMask and sandbox properties (with its code copy
additionally read-only):

```sh
sudo node scripts/deploy-acceptance/rehearse-host.mjs EXISTING_UNIT MAPPED_SCRATCH_PARENT RECEIPT
```

This checks real root-owned 0600 files and 0700 parents, clear MCP permission errors,
positive namespace preflight, the operator CLI and complete acceptance, then stops
the transient gateway and deletes its scratch tree. It never uses the production
application environment, credentials or ledger. It is not part of unprivileged CI.
