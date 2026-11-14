# Managed Linux deployment

Use a clean, CI-green published SHA. Preserve the existing restricted service,
credentials, keys, ports, Funnel, registry, mapped data, legacy fallback and audit
ledger/anchor. Source publication does not deploy automatically. Actual ChatGPT
connector acceptance is a separate operator test.

1. Verify the exact remote SHA and all security/platform/distribution CI runs.
   Install frozen dependencies without hooks, build and run the isolated suites.
   Stage immutable root-owned code at `/opt/bridge-dev-releases/<sha>`; verify a
   file/hash manifest, DEPLOYED_COMMIT, CLI and isolated gateway startup.
2. Record current PID/UID/sandbox/unit and protected-file metadata, audit integrity,
   append-only attribute/prefix, registry digest and fallback identity. Check disk
   and the current snapshot policy; take the required pre-change snapshot. Keep
   verified private backups of configuration that might change.
3. Use [the versioned acceptance harness](../scripts/deploy-acceptance/README.md)
   to create/preflight fixtures before stopping production. Its root-private plan
   and all parent permissions must be verified through the actual service mount
   namespace at the service UID. Rehearse negative and positive access on a copy.
4. Run the staged migration command with `--dry-run --json` and an explicit
   `--config /etc/local-coder-policygate/mcp-upstream.json`. A v1 file yields `[]`
   and needs no apply. A reviewed unversioned `servers` document can add version 1;
   inspect the exact diff before applying. Unknown schemas or other changes abort.
   See [registry compatibility and migration](MCP_INTEGRATIONS.md#existing-unversioned-registries-and-explicit-migration).
5. Launch a detached host controller with a persistent job ID, exclusive deployment
   lock and independent bounded rollback timer. Stop only the existing gateway
   unit. Atomically exchange the staged and live physical directories using
   renameat2(RENAME_EXCHANGE); retain the original directory for rollback. The
   production preflight requires a physical `/opt/bridge-dev`, not a symlink.
6. Start the same unit. Verify health, identity, sandbox and listener ownership.
   Run the harness with the new PID and schema validation enabled. This includes
   context then pwd, unapproved privilege/destruction denial, client isolation,
   every exposed read tool including skills_validate/load_skill, and admin auth.
7. On any failure/deadline, automatically stop that unit, exchange back the verified
   original directory, restore only a controller-owned migrated registry backup
   if its digest still matches the expected transaction state, and restart the
   original restricted service. Re-run baseline acceptance and audit/protected-file
   checks. Keep the failed candidate and exact error receipt; do not retry blindly.
8. Disarm the guard only after acceptance and protected-state checks pass. Remove
   fixtures, transient units/timers, archives, locks and sudo cache; retain release,
   backup and result receipts. Update the canonical deployment/system documents
   with actual results. Reconnect ChatGPT separately; do not claim account acceptance.

## Lessons verified on 2026-11-14

- `skills_validate` formerly returned an array at native envelope `data`, whose
  schema required an object. e0fb19e wraps it in `data.results`; CLI JSON retains
  its array contract. The real SDK regression covers 73 native registrations and
  routed provider schemas, including invalid/null/missing/extra output cases.
- e0fb19e cutover rolled back because its ad hoc root fixture inherited UMask=0077:
  parents were 0700 and SKILL.md was 0600. The replacement builder explicitly sets
  all modes, verifies real service access before MCP calls, and cleans up by plan.
- The explicit root rehearsal passed with UID/GID 947, UMask0077, ProtectHome=yes,
  ProtectSystem=strict, PrivateTmp=yes and copied bind/read-only settings. Real
  root-0600 and parent-0700 fixtures were rejected; readable fixtures passed all
  31 exposed read cases. The rehearsal used synthetic state and no production
  credentials. Actual deployment results belong in the operator receipt/canonical
  system documentation, not in this procedure.
