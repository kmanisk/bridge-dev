# Persistent portable Linux service

## Shadow acceptance update (Linux, operator-initiated)

An operator with an independently signed active YOLO lease can run
`bridge-dev update` without a temporary STANDARD switch or a second YOLO
confirmation. **The lease and root-owned host-controller records are never
written, renewed or copied by the updater.** The code verifies exact GitHub
commit/CI/digest, stages the release once in the operator account, and queues
a tracked systemd *user* update unit with a fingerprint of the existing signed
lease. The unit re-verifies the immutable staged artifact; no second `gh api`
call or GitHub credential inheritance is required.

Before the live service is stopped, the worker launches a temporary
bubblewrap namespace with a read-only release, synthetic tokens, a disposable
namespace-owned `tmpfs` workspace, **separate mount/user/PID/network
namespaces**, no host home, controller, production state, host login secrets,
or Funnel. Rootless UID mapping makes host-root diagnostic binaries appear
untrusted inside the user namespace; only `git`, `id` and `echo` are copied
after checking root ownership, file mode and byte hashes, then mounted
read-only from a path inaccessible to the candidate. This preserves the
gateway's ordinary diagnostic executable validation. An independent
MCP SDK client checks the 52 native tools, schema/read contracts, admin auth,
and privilege/destructive denials within that sandbox. Namespace setup,
loopback, canary, or acceptance failure **aborts without cutover**.

Only after shadow acceptance passes does the tracked job atomically switch
the verified release and restart the existing user service. It runs **positive
checks only** against the live gateway (authenticated health, MCP tool
inventory, schema checks, mode and signed lease unchanged). If the cutover or
smoke fails, the existing guarded rollback restores the previous release,
without creating or extending any lease. A changed or expired lease requires
operator review; it is never restored automatically. A concurrent update uses
the existing durable job lock. No watcher or new persistent service is
installed.

This path requires a working Linux bubblewrap `bwrap` and network/user
namespace support; it fails closed if the sandbox cannot prove isolation. Use
`bridge-dev update --standard-window` to explicitly request the older
STANDARD/negative-acceptance window and independent restoration prompt.
On STANDARD-only systems, normal updates retain the existing flow.

**Bootstrap:** If the currently installed CLI predates this change, it
cannot provide the new shadow flow. Run the verified *new* CLI from a trusted
built checkout in your local operator terminal for the one-time migration.
Do not repeatedly retry the old updater after `SERVICE_GITHUB_*` failures;
inspect the existing job and release state first.

The persistent service's actual `NoNewPrivileges=no`, `PrivateTmp=no`,
`ProtectHome=no`, or `ProtectSystem=no` are **not** shadow hardening
settings: the user service may have deliberately relaxed them for the
independent sudo host controller. Such a YOLO-compatible gateway has weaker
OS sandboxing, must not be presented as a restricted-service-UID deployment,
and requires separate operator hardening review. The ephemeral shadow uses
its own namespace boundaries; no installed unit hardening is silently changed.



The portable gateway can run as a systemd **user** service. It remains an
unprivileged STANDARD gateway; this does not provision the independent managed
Full System controller. Tailscale stays optional and service commands never
modify Funnel. If the gateway stops, an existing Funnel route returns upstream
errors until the same loopback listener is healthy again.

## Install and inspect

### Compact terminal output and diagnostics

Routine `bridge-dev` commands print a concise status line by default. For
`bridge-dev update`, the console shows the target release and verified outcome;
any warning or failure appears as a short diagnostic line. The independent
**Full System / YOLO authorization prompt remains visible** and is never
automatically confirmed, redirected, or suppressed by the updater.

Detailed deployment acceptance receipts stay in the existing transient
systemd update job journal (`bridge-dev service logs --job <uuid>`). Additional
on-demand CLI events are appended to
`~/.local/state/bridge-dev/private-cli/events.jsonl` (private directory `0700`,
file `0600`, bounded on-demand rotation). The CLI log records status, release,
job ID, and a sanitized brief reason, **not** tokens, connection URLs, full MCP
payloads, or the privileged operator's terminal output. AI agents may inspect
the file and the linked job journal when diagnosing failures.

Use `--verbose` for expanded human output and `--json` for stable machine-
readable results. Explicit `bridge-dev service logs` and `bridge-dev access`
remain detail-oriented by design. No logging service or watcher is installed.

Build a clean checkout first, or run from an installed, marked release. Keep the
existing user-owned mode-0600 environment file with independent MCP/admin tokens.
Installation references that file; it never embeds or copies its credentials.

```sh
bridge-dev service install --config "$HOME/.config/bridge-dev/.env"
bridge-dev service start
bridge-dev service status --json
bridge-dev doctor
bridge-dev service logs --lines 80
```

Install is idempotent, writes only a BridgeDev-owned unit, reloads the user manager
and enables the service. `--no-enable` leaves boot activation disabled; `--start`
also starts it. Existing custom units are not overwritten. Uninstall stops and
disables the unit but preserves releases, state, credentials and linger.
`start`, `stop`, `restart`, `enable` and `disable` are also service subcommands.
Top-level `start`, `stop` and `restart` use the installed user service; `serve`
continues to run a foreground gateway and refuses occupied ports. The existing
explicit `bridge-dev start --funnel` opt-in also works with the persistent service:
it waits for authenticated readiness before invoking the ownership-aware exposure
helper. Ordinary start and every service subcommand leave Funnel unchanged.

Boot without login additionally requires linger. Status reports it; the CLI
reports the exact operator command if missing:

```sh
sudo loginctl enable-linger "$USER"
```

### Opt-in autostart during local YOLO activation

After the root operator accepts `bridge-dev mode yolo`, the CLI verifies the signed lease and offers **another, default-No** interactive confirmation for boot persistence. `y` reuses `bridge-dev service install` when no owned service is installed, otherwise `systemctl --user enable` to create the managed `default.target.wants` symlink; if `loginctl` shows no linger, it requests `sudo loginctl enable-linger <uid>`. It checks installation, enablement, and linger again before reporting success. `n`, missing TTY, failed YOLO activation, or already-complete boot setup never make additional system changes. All operations run as the local operator, with no service restart, extra daemon, credential change, Funnel change, or YOLO lease renewal. A newly installed standard-sandbox unit may still block sudo escalation: that requires independent controller-compatible service review, never automatic sandbox weakening. If an operation fails, the CLI reports partial boot setup without pretending to revoke the signed YOLO lease.

No reboot is performed by installation. Verify manually after reboot: check
`systemctl --user is-enabled bridge-dev.service`,
`systemctl --user status bridge-dev.service --no-pager`,
`loginctl show-user "$USER" -p Linger`, `bridge-dev doctor` and the authenticated
MCP acceptance calls below. Check that ports 3000 and 3001 belong to one PID.

## On-demand update notifications (no new service)

For interactive, non-JSON CLI commands only, BridgeDev makes a bounded GitHub
main commit check when its local cache is missing or six hours old. It reads
the immutable installed release marker and displays a suggestion to run
`bridge-dev update` when the commits differ. Failure to reach GitHub is
nonfatal. `BRIDGEDEV_UPDATE_NOTICE=off` disables these hints. There is **no**
watcher, timer, service, auto-update or background polling. Automatic
instant-on-push notification would require an always-on check/push receiver;
this design intentionally defers detection to the next eligible CLI use.

The localhost Admin Overview offers an authenticated **manual** GitHub main
check; it reports both hashes without mutating anything. A newer main commit
still has to pass exact-SHA CI and guarded update acceptance.

## One-command verified updates

`bridge-dev update --check` retrieves the current GitHub `main` SHA
through the operator's authenticated `gh` CLI and reports whether the installed
release differs, without modifying the service.
`bridge-dev update` is the **single-command operator workflow**, accepting
either STANDARD or an independently signed, active YOLO lease. In YOLO from
an interactive local terminal it **first verifies GitHub CI and stages
the exact artifact** while authorization remains unchanged. Only when that
preflight succeeds does it invoke the root-owned operator script to revoke
authorization to STANDARD, then call the existing
`service update <exact-sha>` flow. That flow validates exact-commit CI,
artifact integrity, native and reviewed optional tool inventories, protected
rollback and acceptance. Only after terminal SUCCESS, installed SHA equality,
active service status and verified STANDARD state does the CLI offer
independent local operator confirmation to reauthorize the prior YOLO mode.

The operator runs one command, not separate `mode standard` and `mode yolo` commands. A durable, independently tracked update job runs after the temporary STANDARD transition, not with unrestricted root privileges inherited from the MCP gateway. Acceptance explicitly checks that privileged operations are denied, so a YOLO subprocess cannot substitute for STANDARD acceptance. After an interrupted CLI or pending job, inspect `bridge-dev service status --job <uuid> --json` and `bridge-dev service logs --job <uuid>` before retrying.

Only an already authorized **indefinite** YOLO lease uses this automatic
restore path. A timed lease is rejected before any mode transition, because
restoring it as indefinite would widen privileges. Machine-readable
`--json` cannot initiate a YOLO transition.

If the update fails, rolls back, remains pending or the local operator declines
new root confirmation, the CLI does not silently restore privilege. Incomplete
acceptance leaves STANDARD for operator inspection. Remote and noninteractive
calls cannot initiate YOLO transition. `--no-wait` is available only when
already STANDARD; it never reactivates privilege asynchronously.

This does not run `git pull`, modify source checkouts, rotate credentials,
change Funnel, install a new persistent service or weaken systemd sandboxing.
Only the existing guarded updater controls the service restart at cutover.

### Optional MCP providers during release acceptance

The independent portable acceptance must always find **every pinned native tool**
in `profiles/native-tool-counts.json` (52 in the slim profile). A reviewed,
operator-enabled optional MCP provider may expose additional proxy tools, so
the total MCP tool count is **not** necessarily the native count. For example,
52 native tools plus three approved REA guidance tools is 55, not a regression.
Additional names are accepted only when explicitly permitted by the
authenticated Admin upstream configuration: an enabled reviewed allowlist,
or reviewed `all` exposure with individually granted tool permissions.
Unknown, disabled, duplicate, or missing native tools fail closed.

Deployment acceptance validates approved optional tool schemas but does not
invoke or start optional tools. All native read-tool and security-isolation
checks remain mandatory. Rollback is reserved for actual regressions.

## Layout and updates

Default installation root: `~/.local/share/bridge-dev` (XDG/explicit installation
root overrides are supported). Releases are `releases/<40-character-sha>`;
`current` is an atomically replaced relative symlink. Private schema-1 controller
configuration and receipts live in `service/`. Previous releases are retained.

```sh
bridge-dev service update <sha-or-tag>
bridge-dev service status --job <uuid> --json
bridge-dev service logs --job <uuid>
bridge-dev service rollback
```

Updates require `gh` authenticated in the **operator account**. The updater checks
successful push/main runs of all three repository workflows on the exact SHA,
downloads that SHA's CI-built `bridge-dev-node-<sha>` artifact, verifies GitHub's
SHA-256 ZIP digest and the embedded per-file manifest, rejects unsafe archive
paths/symlinks/extra files, and stages without package hooks or source fallback.
Artifact retention is 30 days; an expired artifact is a precise blocker. The
initial local bootstrap release is explicitly marked operator-seeded, not CI
verified. A dirty unmarked checkout cannot become a bootstrap release.

**Full System maintenance gate:** The portable release acceptance deliberately
checks that privileged and destructive commands are denied. An active signed
Full System (YOLO) lease makes those probes inappropriate. Therefore service
update and rollback now require an authenticated, healthy **STANDARD** gateway
and refuse YOLO with `SERVICE_UPDATE_REQUIRES_STANDARD` before staging or
stopping production. The detached worker repeats this check immediately before
cutover. Only the independent local operator can change the lease; service
commands never switch modes automatically. Preserve an active YOLO installation
until the operator explicitly authorizes a STANDARD maintenance window.
If the running gateway rejects the protected environment file's Admin credential,
the updater reports `SERVICE_ADMIN_CREDENTIAL_DRIFT` and refuses release changes.
This can happen when the environment file changes after service startup; reconcile
the running and persisted credentials using the independent local operator workflow.
Never print tokens, rewrite them silently, or restart a gateway with mismatched
credentials: doing so may disconnect existing MCP clients.

A single exclusive update lock and persistent job UUID prevent blind duplicate
updates. The on-demand `systemd-run --user` controller is independent of gateway
connections. It has a 180-second deadline and an `ExecStopPost` rollback guard.
Before stopping the gateway it checks free disk, hashes, an isolated-port SDK
probe and credential-file identity. It stops only its configured gateway,
appends a service audit event while that writer is stopped, switches `current`,
starts and accepts the new runtime. Live events use the gateway's authenticated
operator route, avoiding a second audit writer.

Failed preflight leaves the running gateway untouched. Failure after stopping or
switching restores the previous pointer/configuration, resets the start-limit
state, restarts the previous release and verifies health. The ledger is never
restored or replaced. A retained pre-service bootstrap runtime has no completion
audit API: after SDK acceptance the controller stops that writer, appends the
acceptance receipt offline, restarts it and checks final health. The newer operator
CLI is retained across gateway rollback. Inspect the recorded job before retrying an unknown result.
`rollback` repeats harmlessly once the previous release has been selected.

The one-time `service adopt <sha> --transient bridge-dev-portable-SHA.service
--previous-app <path>` transaction restores the original transient runtime on
failure. Run it only after staging the verified target and recording the
transient unit's original properties. Keep its original app until success.

## Hardening and limits

The unit uses an absolute Node entrypoint, no shell or login wrapper, `Type=exec`,
`Restart=on-failure`, 3-second backoff, four starts per 60 seconds, 30-second graceful
stop and `KillMode=control-group`. Default limits are MemoryHigh=768M,
MemoryMax=1024M and TasksMax=256, configurable at installation.

Compatible rootless defaults retain `NoNewPrivileges=yes`, `UMask=0077`,
`RestrictSUIDSGID=yes`, `LockPersonality=yes`, `RestrictNamespaces=yes` and
`SystemCallArchitectures=native`. Node options and library injection environment
variables are unset. Journald rate-limits this unit to 200 messages per 30 seconds.
V8 JIT requires executable memory; `MemoryDenyWriteExecute` is intentionally absent.

On the tested CachyOS systemd user manager, `PrivateTmp`, `ProtectHome`,
`ProtectSystem`, `ProtectKernelTunables`, `ProtectKernelModules` and
`ProtectControlGroups` each implicitly introduce a user namespace that maps host
UID 0 to 65534. This breaks BridgeDev's independent root-owned executable check.
They and `PrivateUsers` are therefore omitted by the compatible `basic` default.
The ownership check is retained. This service relies on existing OS account
permissions plus BridgeDev workspace/policy checks; it is not a filesystem sandbox.
The optional `full` unit renderer needs separate platform compatibility acceptance
before use and is not the verified workstation configuration.

The app bounds HTTP JSON to 2 MiB, gateway/admin concurrent connections to 64/32,
request/header deadlines to 30/15 seconds, live provider connections to 16,
background jobs to 32 active/256 retained records, activity history to at most
2,000 entries and queued audit writes to 1,024. Shutdown stops providers and owned
process groups, closes sessions/listeners and drains fsynced audit writes. Audit
verification streams in bounded chunks without rewriting or rotating the ledger.

## Health, state and acceptance

`GET /healthz` is unauthenticated and returns only `{"ok":true}`. Detailed MCP
`/health` now requires the MCP bearer credential; admin `/health` requires its
independent admin credential. Sensitive APIs use no-store. Do not put credentials
in terminal command arguments or unit files.

Service config, release manifests, extension locks and runtime settings are
versioned. Known unversioned local tool/plugin/hook and shell state is validated
in memory. Future or malformed versions fail closed. Explicit settings writes
are atomic and backed up; they go to protected state, never into release code or
the credential file. Browser environment editing accepts only the tool profile,
shell timeout and checkpoint enablement; applying them requires an operator CLI
restart. Authentication, paths, policy and signing state remain offline-only.

The reviewed rehearsal is `scripts/deploy-acceptance/user-service.mjs` with
`--execute-staging --evidence <private-directory>`. It logs its exact unit/path
inventory before changes and uses synthetic credentials, random ports and its own
ledger. It tests SDK/schema acceptance, crash restart, port conflicts, provider
child cleanup, clean stop, detached update, failed-cutover rollback and start-limit
recovery. Unit/artifact/locking tests run in ordinary CI without a user manager.

After deployment, independently authenticate an SDK client, discover tools, load
system context, run `pwd`, verify privileged/destructive denials and another
client's isolation, and call all read tools with output-schema validation. The
portable runtime has no managed context prerequisite by default; do not invent a
before-context denial that is not configured. Context enforcement is verified in
the separate managed-session regression suite. Actual ChatGPT acceptance belongs
to the account operator: reconnect, open a new chat, inspect tools, then call
`system_context`, `run_command` with `pwd`, `mcp_list` and `skills_validate`.

For an explicit compatibility rehearsal with a retained public pre-service runtime:

```sh
node scripts/deploy-acceptance/legacy-rollback.mjs --execute-staging \
  --legacy-release <retained-runtime-directory> --evidence <private-directory>
```

This creates only its inventoried temporary unit with synthetic credentials,
checks the actual old runtime and operator-CLI retention, and removes the fixture.
