# Optional Linux host controller

The network gateway stays under its restricted UID and mount namespace. The
optional controller runs commands in root transient **system** units created by
the host systemd manager. It adds no permanent daemon. Python 3, Node.js, systemd,
sudo and the existing Ed25519 operator public key are required; no npm dependency
is added. Windows/macOS portable gateways do not install this component.

## Authority and limits

An independently opened root terminal issues the existing signed YOLO lease:

```sh
sudo /usr/bin/node /opt/bridge-dev/scripts/policygate-operator.mjs yolo --duration 60
sudo /usr/bin/node /opt/bridge-dev/scripts/policygate-operator.mjs yolo --off
```

With the controller installed, activation also records the signed lease nonce in
root-only controller state. Replaying a copied lease after revocation cannot
reactivate that nonce. The legacy escalation broker path delegates to this same
controller, with no separate signature-only authorization path. Activation requires root and a TTY. The remote helper
cannot activate a lease through its sudo entry. Duration is 1–120 whole minutes;
invalid values fail rather than silently selecting another duration.

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
