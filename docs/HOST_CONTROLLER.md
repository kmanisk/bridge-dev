# Optional Linux host controller

## Lease persistence across a gateway restart

The signed `host-root-v1` lease, active nonce/expiry record, and public
verification key live outside the Node gateway process and are managed by
the independent root operator. A gateway restart alone neither revokes nor
renews that lease. The shadow updater fingerprints those protected values
before cutover and requires exactly the same scope, expiry and signed
activation afterward. It never calls the operator's activation action.
A timed lease that expires during the transaction is *not* extended.

Shadow validation is performed in a separate rootless bubblewrap namespace,
where the independently installed controller and protected files are absent.
The previous STANDARD-window updater remains an explicit
`bridge-dev update --standard-window` fallback. In any failure, inspect
the tracked job; never blindly re-run a partially completed update.

**Host hardening trade-off:** An installed gateway using sudo to contact the
root controller may need `NoNewPrivileges=no` and a basic systemd sandbox.
That is a material security cost of persistent remote root access, not proof
of a hardened restricted-UID deployment. Never change the running service
unit or root controller automatically as part of an update.



The network gateway stays under its restricted UID and mount namespace. The
optional controller runs commands in root transient **system** units created by
the host systemd manager. It adds no permanent daemon. Python 3, Node.js, systemd,
sudo and the existing Ed25519 operator public key are required; no npm dependency
is added. Windows/macOS portable gateways do not install this component.

## Two user-facing modes

- `bridge-dev mode standard` (alias: `bridge-dev mode read-write`): ordinary scoped filesystem, Git and command work across authorized workspaces.
- `bridge-dev mode yolo` (alias: `bridge-dev mode sudo`): prompts for confirmation in the operator's own terminal (`Enable Full System (sudo)? [Y/n]`). Pressing **Enter** (default Yes) or typing `y` enables Full System **indefinitely until manually switched off**, including after reboot. Type `n` to decline.
- `bridge-dev mode yolo --duration 60`: optional time-limited access for 1–120 minutes.
- After **successful verified YOLO** in a local interactive terminal, a second prompt asks `Enable persistent BridgeDev systemd service at boot? [Y/n]`. Answering `y` or Enter enables the existing BridgeDev-owned user service or installs it through the existing safe installer if missing, then enables linger with independent sudo if required. This is separate consent; answering `n` changes nothing. Boot setup never restarts a working gateway, creates an extra service, or changes the signed lease. When already enabled and lingered, accepting the second prompt only verifies that state; it makes no changes.
- `bridge-dev mode yolo --off` (or `bridge-dev mode standard`): revokes the lease and returns to STANDARD mode.

**Operator commands:**

```sh
bridge-dev mode status        # Current operator-selected state
bridge-dev mode standard      # Return to Standard mode / revoke Full System
bridge-dev mode yolo          # Independent local confirmation; until manually off
bridge-dev mode yolo --off    # Revoke Full System explicitly
```

Both `standard`/`yolo` and legacy `read-write`/`sudo` aliases are supported across the unified CLI. The [release-readiness milestone](../docs/MILESTONES.md) tracks this verification.

**Security boundary:** If an installation removes `NoNewPrivileges` or related systemd sandbox controls to allow sudo, it loses OS isolation. Neither application-level denylisted paths nor a signed `until_off` lease can contain arbitrary commands already executing as host root. Operators must review the actual installed unit, controller version, endpoint exposure and revocation behavior; a successful `id -u` is proof of execution, **not** proof of containment.

This requires the separately installed root-owned controller. The internal STRICT
profile remains a **fail-closed safety lock**, not a third user-facing choice.
If the controller is installed but the protected mode is STRICT, explicitly
select `read-write` locally; never silently downgrade that safety lock.

## Authority and limits

An independently opened root terminal issues the existing signed YOLO lease:

```sh
sudo /usr/bin/node /opt/bridge-dev/scripts/policygate-operator.mjs yolo
sudo /usr/bin/node /opt/bridge-dev/scripts/policygate-operator.mjs yolo --off
```

With the controller installed, activation publishes the signed lease nonce in
root-owned `/var/lib/bridge-dev-operator/active-lease.json`, readable by the gateway
and writable only by the operator/controller. The gateway and root authorizer both
require this same record. Replaying a copied lease after revocation cannot restore
root access or application-level YOLO permissions. The legacy escalation broker path delegates to this same
controller, with no separate signature-only authorization path. Activation requires root and a TTY. The remote helper
cannot activate a lease through its sudo entry. Omitting `--duration` issues a signed `until_off` lease with no expiry.
Explicit `--duration` accepts 1–120 whole minutes and rejects invalid values.

Full-host leases sign a `host-root-v1` scope as well as their nonce and expiry.
Older gateway versions cannot accept that signature as a legacy YOLO lease after
rollback. Unscoped legacy leases do not activate full-host YOLO in this version.
Activation requires the optional controller to be installed.

**Activation directory permissions:** `/var/lib/bridge-dev-operator` must
be root-owned mode **0755**, with `active-lease.json` root-owned mode **0644**.
It contains only the approved mode, nonce and expiry; signing keys remain private.
Bootstrap explicitly corrects its directory mode after creation because a root
installer using `umask 077` otherwise creates it as **0700**. When this directory
is inaccessible to `localcoder`, the gateway intentionally falls back to
STRICT and `pwd` may return `POLICYGATE_APPROVAL_REQUIRED` even though the
root operator reports STANDARD. Inspect path owner, type and permissions before
making the minimal correction. Do **not** chmod secrets or relax the gateway
systemd sandbox. Verify the gateway reads STANDARD and that context -> pwd
passes before attempting another release cutover.

An `until_off` lease carries a signed `lifetime:until_off` claim and
`expires_at:null`, paired with the root-owned activation nonce.
Each root command retains its own timeout. Selecting Read & Write or sudo --off
revokes the authorization and prevents new root commands.

The activation record also holds the STRICT/STANDARD base mode. Once the
controller is installed, gateway permissions and signed root approvals use that
protected mode; the old service-writable mode file cannot downgrade it. Missing,
malformed or writable activation state fails closed to STRICT. Operator mode
changes require the independent root terminal and revoke active command jobs.

YOLO `run_command` executes arbitrary `/bin/bash -c` commands as host root,
including ordinary `sudo`, package managers and multiple shell operations. There
is no root-command allowlist or per-command approval in this path. Context
validation remains mandatory. Native file tools keep their existing boundaries;
use root commands for host files outside those boundaries.

The root authorizer checks the signature, expiry and activation nonce before
submission, again before starting, and while a command runs. RuntimeMaxSec and
KillMode=control-group bound transient jobs. Revocation stops tracked command
units; the supervisor checks every 250 ms while active. Normal process exit also
cleans the unit's remaining children. A revoked decision never falls back to
ordinary shell execution. In STANDARD an explicitly signed `sudo` run_command
with an explicit working_directory can use the same controller once; exact
arguments, directory, signature and root-owned spent receipt prevent replay.
STRICT continues to refuse sudo.

**Unrestricted root is not tamper-proof lease isolation.** Root can change sudoers,
copy local signing keys, alter this controller or move work into another unit.
Revocation controls new controller submissions and its tracked units; it cannot
undo persistent host changes or revoke an escaped root process. Preventing an
unrestricted root agent from minting another lease requires a signer outside its
reach and independent enforcement. No local controller can promise otherwise.

## Installation and commands

The operator must review the source and manifest before bootstrap. The installer
copies only the controller, verifier and operator script into root-owned
`/usr/local/libexec/bridge-dev`, installs the fixed helper and narrowly scoped
sudoers entries, replaces the legacy broker with a backed-up compatibility
adapter, and writes `/etc/local-coder-policygate/controller.json`. Existing
controller configuration must match; upgrades do not silently rewrite it. It
does not restart the gateway, issue a lease or modify credentials/keys/ledger.
The public activation directory contains only mode, nonce and expiry, never key
material or credentials. Bootstrap retains a legacy STRICT restriction but never
imports a legacy override that would relax a root-owned STRICT policy.

```sh
python3 scripts/install-host-controller.py --source . --print-manifest
# Independent root terminal, using the reviewed manifest SHA:
sudo python3 scripts/install-host-controller.py --source /absolute/reviewed/checkout --manifest-sha256 SHA
```

Verify installer bytes separately before running it with root. For an initial
installation before the updated gateway is deployed, the sealed operator script
is `/usr/local/libexec/bridge-dev/policygate-operator.mjs`.

```sh
bridge-dev operator status --json
bridge-dev operator yolo on --duration 60
bridge-dev operator exec --request-id UUID --cwd / -- /usr/bin/id -u
bridge-dev operator status JOB_ID --json
bridge-dev operator logs JOB_ID
bridge-dev operator yolo off

bridge-dev deploy plan --release /opt/bridge-dev-releases/IMMUTABLE-STAGE
bridge-dev deploy start --release /opt/bridge-dev-releases/IMMUTABLE-STAGE --request-id UUID
bridge-dev deploy status JOB_ID --json
bridge-dev deploy logs JOB_ID
bridge-dev deploy verify JOB_ID
bridge-dev deploy rollback JOB_ID
bridge-dev deploy cleanup JOB_ID
```

Save the request UUID before submission. Retries with the same exact request
return the existing receipt; changing its arguments fails. Check status before a
retry. The submission lock and deployment lock prevent concurrent cutovers.
`verify` inspects the completed acceptance receipt; it does not rerun acceptance.
Raw command output requires a current lease or still-valid exact signed approval;
sanitized deployment events remain available after the lease ends.

Jobs, requests, logs and results live under root-only
`/var/lib/bridge-dev-controller/jobs/<UUID>/`. The controller keeps a separate
locked hash-chained audit at `/var/lib/bridge-dev-controller/audit.jsonl`. It never
writes concurrently into the gateway's existing ledger. Gateway calls record the
job receipt in that ledger. Cleanup removes output only and retains receipts and
the controller audit chain. Neither controller rewrites the independent anchor.

## Deployment and rollback

Stage a built, reviewed release under the configured releases directory. Its
files must be root-owned and not group/world writable; pnpm symlinks must stay
inside the payload. Include DEPLOYED_COMMIT and production-acceptance.mjs. Preserve
the installed host shim when staging. The controller verifies the payload and
serializes the transaction, then arms an independent 180-second rollback timer
before stopping the gateway. It atomically exchanges physical directories at the
existing install path (a symlink would violate production preflight).

Health and independent MCP acceptance run against the same restricted service.
Acceptance tests all 52 slim tools, separate clients, session and stateless context,
root UID/host mount namespace/sudo on a disposable directory while YOLO is active,
tracked-job revocation, STANDARD restrictions, registry and admin authentication.
Acceptance ends the lease; it never renews it. Protected configuration hashes and
the append-only ledger identity/prefix are checked. Failure restores the previous
directory and restarts the same service. The independent watchdog stops a stuck
primary job before recovery. Receipts record the retained rollback directory.

The root watchdog can restore without an active lease; remote rollback commands
require independent authorization. Nothing restores/truncates the audit ledger,
resets providers, edits Funnel or changes the legacy rollback installation.
Production acceptance is not evidence of ChatGPT account behavior: reconnect the
connector and test a new chat separately.

## Verification boundaries

`test:policy` and `test:all` include cryptographic controller fixtures and
unprivileged transaction-copy rehearsals. They test arbitrary argument arrays,
multi-command execution, revoked/expired leases, exact approval binding, duplicate
submissions, concurrent locking, restart recovery, audit tampering, success and
failure/timeout rollback. They never install sudoers, touch real configuration or
start system units. Actual host-root and production results must be reported
separately after an independently authorized installation.
