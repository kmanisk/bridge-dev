# Security policy and operational controls

This is an unreviewed development build. Do not expose sensitive roots or grant
broad executable access before reviewing its policy and the documented limits.
Report vulnerabilities privately to the eventual maintainer; no public security
contact or hosted reporting endpoint exists while naming/publication is pending.

## Controls

- Default readonly; invalid/missing explicit configuration never widens modes.
- Mode-specific registry, with no hidden callable write/sudo tools in readonly.
- HTTP rejects sudo/dangerous and requires authentication for every MCP request.
- Loopback binding, exact Host/Origin validation, no trusted proxy headers.
- Request-body, concurrency, timeout, output, search and file-size bounds.
- Descriptor-relative path access; no EvalSymlinks-only TOCTOU claim.
- Linux rejects arbitrary symlinks/mount crossings/special files before data open.
- Atomic replacement avoids escaped/hard-linked target mutation during writes.
- No request-controlled shell/environment; explicit allow/deny executable policy.
- Sudo is noninteractive, separately allowlisted and local-only. Passwords are
  never requested. Preview validation does not install sudoers.
- Worker-owned process groups; stale task records cannot cause arbitrary PID kills.
- Persistent final task status is independent of systemd's collected metadata.
- 256-bit bearer/consent/code/token randomness, 0600 files, private state dirs.
- PKCE S256, exact redirect registration, CSRF and state, resource binding,
  expiring opaque tokens, hashed credential storage, refresh rotation/replay
  detection, and family revocation. Token comparisons use constant-time helpers
  where a secret comparison is needed; opaque token lookup uses SHA-256 keys.
- Audit contains a fixed metadata schema, redacts by omission, rotates locally,
  and has no telemetry/export path.

## Boundaries

Readonly means filesystem/process/task observation, not a guarantee against data
exfiltration by a client. Any allowed read can reveal secrets stored in that
root. Task argv and logs are sensitive private operational data. Model requests,
file contents, command output and website instructions are untrusted.

Executable allowlisting authorizes the whole executable, including file/network
access, flags, subprocesses and interpreters it can invoke. This is not seccomp,
a container, a VM, or a filesystem sandbox for commands. Explicit denied paths
do not block a different program implementing equivalent behavior. Grant
execution only when that delegation is intended. A privileged executable can
modify or compromise this server; scoped sudoers must independently enforce the
human's privileged boundary.

Local OS-account compromise, root, malicious bind mounts/device creation,
symlinked state parents controlled by the same user, and hostile replacement
of installed executables are outside the trusted-user-state boundary. Linux
NO_XDEV reduces mount attacks; macOS relies on trusted mount/device setup.
Only Linux amd64 has runtime evidence in this run. Other builds are compile
checks, not security validation.

Do not grant roots that include the config/state directory or credentials.
Environment allowlists must exclude secrets. No encryption-at-rest is supplied.
Protect task logs, OAuth database, local consent terminal, and backups with OS
permissions and disk encryption. A tunnel trusts its provider's TLS termination.

## OAuth limitations

OAuth 2.1 remains an Internet-Draft; implementation follows the authorization
code/PKCE profile and referenced RFCs, not a certification. Current clients must
support RFC 7591 registration (public none or confidential client_secret_basic)
or be adapted. Client ID metadata documents are not implemented. There is no external
identity provider, multi-user account system, admin UI, registration CAPTCHA, or
per-user filesystem authority. Registration/pending/token counts are bounded;
Internet-facing abuse resistance still needs operational review. Restart with
changed issuer/mode fails closed. Rotate state deliberately for Quick Tunnel
hostname changes. Normal OAuth authorization codes appear in callback query
parameters as required by the flow; access and refresh tokens never do.

## Failure handling

An audit-intent append must succeed before tool work starts. A completion-audit
failure can occur after a side effect: the client receives an error and must
inspect the result before retrying. Storage failures, OS reboot, forced worker
kill or power loss before final status persistence can produce `lost`; do not
interpret it as success or retry destructive argv blindly. Initial task launch
is not a transaction with systemd; a `starting` record older than ten seconds
without a running record is reported lost. Completed tasks do not auto-prune;
log bytes are bounded per task but total retained task storage is user-managed.

## Phase 2 M10 changes

Default runtime consent is terminal-only with a six-digit browser match code;
the browser cannot approve itself. Pairing-code consent remains an explicit
compatibility option. Client/session revocation is rechecked per authorization
use, including previously captured principals. Old-scope credentials invalidate
on configured mode change, with private recoverable state backups. A public
origin's credentials are not transferred to another origin. Client names are
self-reported labels, never cryptographic provider identities.

Bridge has no operated accounts, hosted infrastructure, telemetry or relay.
Cloudflare Tunnel is an optional third-party hosted transport. Cloudflare and
AI vendors are separate trust boundaries and can observe traffic passing through
their services. OAuth does not make either provider trustworthy. Prompt injection
remains a serious risk when reads of untrusted content precede writes/execution.
Earlier Phase 1 statements above are historical where superseded explicitly by
docs/SUPERSEDED_RESTRICTIONS.md; remote privilege is still awaiting M12 here.
