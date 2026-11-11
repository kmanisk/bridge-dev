# Security policy and boundaries

This development build has local automated evidence, not an independent security
audit or formal OAuth certification. Report issues locally to the operator; no
hosted reporting/telemetry endpoint exists. Do not post tokens, state files,
private keys, file contents or sensitive audit paths in public reports.

Bridge operates no accounts, infrastructure, analytics, subscriptions, billing
counter, tool-call quota or relay. Optional Cloudflare Tunnel is a third-party
hosted relay. Cloudflare and AI vendors can observe traffic flowing through their
services. OAuth does not make those providers trustworthy. An HTTPS health check
only proves reachability. Actual account compatibility must be tested separately.

AI input, file text, websites and self-reported client names are untrusted.
Annotations are hints, not authorization. Prompt injection remains serious whenever
read access is followed by mutation/execution. Neither filesystem nor command
allowlisting is an OS sandbox. An allowed interpreter can invoke more commands.
A compromised OS account/root can bypass Bridge; that adversary is outside scope.
Keep roots narrow: granting write/execution over Bridge binaries, configuration,
state or other startup programs can undermine controls in this same user account.

readonly is the default. Missing/invalid config never elevates. Registry construction
omits forbidden tools and invocation revalidates mode, scope, session, expiry and
revocation. Saved privileged mode needs current startup authorization: typed phrase
or the explicit manual ack_privileged exception. Remote sudo/dangerous needs OAuth.
User-selected approve=none permits automatic authorized operations; it does not
create a grant. Class-session approvals are scoped to identity, authorization
session, origin, mode and class. They do not elevate permissions. Remote dangerous
access may completely compromise this computer and all its data.

OAuth is authorization-code + PKCE S256, exact registered redirect matching,
resource/scope binding, DCR, expiry, rotating refresh and replay-family revocation.
CIMD is not implemented or advertised. Terminal consent serializes through the
shared coordinator, shows the browser's random six-digit code, expires in 60s and
rate-limits repeats. Browser requests cannot approve themselves. Default redirect
hosts are explicit; additional hosts need deliberate configuration. Consent and
tool prompts use the controlling terminal; default is deny. Client identities are
OAuth registrations, not verified Claude/ChatGPT provider identities. Stateless
connection close does not revoke the application authorization session.

Public issuer/resource URLs come from the configured/verified canonical HTTPS
origin, never Host or forwarded headers. Canonical Host checks wrap the SDK. GET /authorize allows ordinary browser
navigation without an Origin and may carry the initiating app Origin. Unsafe
requests reject foreign/null/malformed Origins; consent POST additionally requires
the matching private cookie and CSRF value. Consent documents use same-origin
referrer policy so form navigation does not turn Origin into null. State and iss
return to the exact registered callback, including validated denial/expiry. No
invalid redirect or CSRF failure is redirected. Discovery self-probes cannot extend
idle lifetime. The optional dashboard is unimplemented; no management UI is exposed.
Token headers are mandatory on MCP; health is minimal and exposes only mode.
Local development bearer tokens contain 256 random bits, live in 0600 files and
are never accepted in URL query/path tokens. HTTP has bounded bodies/concurrency,
timeouts and a fixed 25s long-poll ceiling. Tunnels start only when selected;
automated tests use fake processes and loopback proxies. New hostname invalidates
origin-bound credentials and privileged grants; reauthorization is required.

Approvals bind a random ID to client/session/scope/mode, exact input digest and
resolved lexical path/cwd. Descriptor validation occurs again on actual access.
No operation executes before approval. Approval timeout is 120s. Headless gated
operations deny. HTTP returns pending IDs promptly; only the originating client
session can poll results. Durable request_key receipts prevent automatic redispatch.
Ambiguous crashes report unknown; this is not exactly-once execution. Pending
prompts alone do not keep idle lifetime alive; dispatched work does. Revocation and
grant expiry are rechecked after prompts and immediately before process launch.

Linux uses pinned roots/parents and openat2 beneath/no symlink/no magic-link/no
nested-mount resolution. It does not rely on EvalSymlinks for per-call safety.
Restricted writes reject hard links and atomically replace a fresh inode under a
pinned parent. Regular-file checks, sizes and permissions apply. Darwin uses Go
os.Root descriptor-relative traversal, final no-follow checks and device checks;
native concurrent-race/mount behavior remains a manual verification gate. Dangerous
mode deliberately removes normal root and command policy, including symlink/mount
path restrictions, while retaining regular-file correctness and audit checks.
Special-file I/O is explicitly unsupported by file tools; unrestricted argv can
use native tools when deliberately authorized. Atomic replacements preserve normal
permission bits, not ownership/ACLs/xattrs or inode identity.

Commands are literal argv with explicit cwd, environment allowlisting, deadlines,
output bounds and owned process groups. No implicit shell exists; dangerous --shell
is explicit. sudo -v attaches directly to the controlling TTY; Bridge never reads
a password. Actual commands use sudo -n. Detached/headless workers must never wait
for a password and cannot assume a terminal's sudo cache. Privileged task launch
uses sudo -n systemd-run; its worker runs as the original user and needs separate
noninteractive sudo authorization, commonly explicitly scoped NOPASSWD. Do not
place broad shells/wildcards into default sudoers rules. Preview/confirmed install
checks an immutable digest, validates the same bytes with visudo, refuses overwrite
and installs atomically. Tests use PATH shims only, never real sudo or sudoers.

Durable workers outlive transport/server exit. Final results are independently
persisted before unit collection. Stale PIDs are never blindly signalled; stop
requests target task control metadata and owned process groups. Grant expiry does
not kill running jobs. Forced worker death/reboot can lose an uncaptured result.
Storage failure fails safely before sensitive dispatch and can leave a completion
finalizer retrying until storage is restored. Protect active task state from deletion.

Private XDG state contains hashed OAuth credentials, request results, task argv
and logs; it can still contain sensitive task data. Keep it private and encrypted
at rest when needed. JSONL audit intentionally records paths, clients, mode,
transitions, reason codes, timing, exit/task IDs and sudo involvement. It omits
contents, full argv, environments, headers, passwords, tokens and consent codes.
It rotates locally; same-user tampering is not cryptographically prevented.
No aggregate task/receipt disk guarantee exists: retain deduplication tombstones,
forget completed tasks deliberately, and monitor free disk. Technical bounds are
configurable resource/abuse controls, not usage billing or monthly quotas.

Older restrictions intentionally replaced are listed in
[SUPERSEDED_RESTRICTIONS.md](docs/SUPERSEDED_RESTRICTIONS.md). See TEST_REPORT.md
and MANUAL_TEST.md for verified checks and remaining external evidence.
