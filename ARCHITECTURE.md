# Architecture

One Go binary owns on-demand stdio or loopback Streamable HTTP. The official
Go MCP SDK is pinned to v1.8.0. Stateless=true, JSONResponse=true and cancellation
propagation are verified SDK APIs; no simple-tunnel SSE dependency exists. No
Bridge daemon, telemetry, account service or hosted relay is involved.

| Package | Responsibility |
| --- | --- |
| identity | Temporary name, module/build metadata, environment prefix |
| config | Strict TOML, safe defaults, CLI > env > file precedence, reversible private migration |
| prompt | Prompter interface and one terminal coordinator; direct sudo TTY delegation |
| connect | Wizard, doctor, startup/clipboard/client instructions |
| transport | Authenticated bounded HTTP, canonical-origin binding, idle/recovery, safe admin status/down/watch |
| auth | Local bearer, OAuth/PKCE/DCR, consent/session/refresh/revoke persistence |
| privilege | Current startup authorization, timed downgrade, validated sudoers install |
| approval | Exact operation digests, per-client queued gates, polling, durable at-most-once dispatch |
| mcpserver | Typed schemas, mode-specific registration, per-call authorization and tool adapters |
| fsjail/filesystem | Pinned filesystem authority, atomic writes/edits, bounded reads/list/search pages |
| execrun | Literal argv, cwd/env policy, bounded output/deadlines, owned-group lifecycle |
| tasks | Independent workers, systemd/detached backends, durable final status/logs/events/cursors |
| tunnel | Owned quick/named/custom argv transports, origin validation/native setup |
| clientinstall | Preview/confirm native registrations, private receipts, ownership-safe uninstall |
| audit/events/platform | Rotated metadata JSONL, safe foreground events, private atomic state/process identity |

Startup: validate preferences and executables, obtain current privilege authority,
start HTTP, establish tunnel origin, create origin-scoped OAuth, then verify health,
AS/PR metadata and the unauthenticated MCP challenge. Only then advertise /mcp.
Exact Host/Origin checks do not trust proxy headers. Loopback bearer administration
is separate from OAuth tool access. /healthz reveals only basic health/mode.

OAuth registrations and hashed credentials persist privately. Six-digit consent
is a local match code, not a bearer token. Browser approval is impossible without
terminal confirmation; code mode preserves the original pairing ceremony. Consent
expires in 60s with one active prompt; tool requests queue independently and share
the coordinator. Refresh rotates and session expiry is fixed; privileged credentials
are clipped to grant expiry. CIMD is not advertised. Client names are self-reported.
Socket lifetime does not determine application authorization session lifetime.

Mutations require request_key. Under a cross-process key lock, an exact digest and
identity/session/scope/origin/mode binding are durably stored before dispatch. A
modified request under that key denies. Pending approval IDs are random and expire;
only their originating authorized session can poll them. HTTP returns pending
before its 25s ceiling, with approval_status/task_wait polling. Approved/dispatched
states are atomic. A dispatcher crash after dispatch and before durable result is
unknown; automatic redispatch never occurs. No exactly-once claim is made. Receipts
must be retained; deleting them forfeits protection against historic retries.

Authorization is checked at invocation, after approval/sudo authentication and
immediately before process launch. Expiry updates registration and effective mode;
old clients cannot dispatch stale commands. Saved preference is not a grant. The
prior safe configured mode is restored, or readonly. Dangerous uses a separate
full-authority file handle; downgrade selects safe roots or denies when absent.

Tasks have an independent worker, private spec/status/logs, process identity, unit
identity and final completion event. Workers audit before executing; final status
is fsynced independently before unit collection. Ordinary Linux tasks prefer
systemd user units; detached workers use separate sessions on fallback platforms.
Privileged Linux task launch uses sudo -n systemd-run with a system unit running
the worker as the original user. The worker independently uses sudo -n, commonly
requiring deliberate scoped NOPASSWD. It never borrows a terminal password/cache.
Root workers do not consume mutable user-owned task specs as root. Stop writes a
task control record; the worker gracefully terminates its own unreaped group before
forced cleanup. Unknown/lost results are not fabricated or automatically restarted.

Tunnel failure pauses advertised access. Backoff is 1s doubling to 30s, bounded
by shutdown/idle. Each replacement is verified; a changed origin invalidates old
credentials and privileged grants. Stable-origin reconnect preserves sessions.
Only owned groups stop. status recovers missing http.json through server.json and
verifies identity plus authenticated local admin response; no stale PID is killed.

File offsets/pages preserve default Phase 1 whole-file/name-list results. Explicit
pagination adds next offsets/eof/more/incomplete metadata. Search never follows
arbitrary symlinks. Cursors are not snapshots; changes may shift ordering. Ordinary
writes use fresh inodes, pinned parents and sync/rename, not EvalSymlinks checks.
Linux openat2 rejects unsupported symlink/mount crossings; macOS uses os.Root,
no-follow/device checks and still needs native runtime validation.

Config/schema migration backs up v1 before private atomic replacement. Restore is
explicit; invalid config never becomes permission to broaden defaults. Runtime
acknowledgment is not saved by normal wizard paths. Native client registration
uses snapshots so a later config edit cannot silently promote an installed client.
Local Git milestone commits are authorized; remotes/publication are prohibited.
