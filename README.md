# Bridge Development

`bridge-dev` is a temporary name for a free, self-hosted Go MCP server. It gives
agents explicit file, command and durable-task capabilities. Codex stdio is the
primary local target; Claude web is the primary remote target. There is no final
product name, Bridge account, hosted infrastructure, telemetry, analytics,
subscription, billing counter or Bridge-imposed tool-call quota.

Build with Go 1.25+ and Make. Runtime is one CGO-free binary, with optional native
cloudflared and sudo tools. Linux needs openat2 and /proc for the restricted file
backend; macOS uses descriptor-relative Go os.Root operations. Native macOS and
ARM64 execution remain unverified. Cross-compilation is tested.

```fish
make build
set -gx PATH $PWD/bin $PATH
bridge-dev connect
```

First run checks cloudflared and asks for roots, mode, approval policy, idle time,
tunnel and, for writable modes, ordinary executable permissions. It explains
missing software and stops without installing it. Preferences save privately in
~/.config/bridge-dev/config.toml. Later runs reuse them; --reconfigure asks again.
CLI flags override BRIDGE_DEV_* environment values, then TOML, then safe defaults.
Invalid configuration fails closed. Runtime state belongs in XDG_STATE_HOME or
~/.local/state/bridge-dev; release/setup never enables a permanent service.

connect starts loopback MCP, terminal-confirmed OAuth and the selected tunnel,
verifies public health/discovery/authentication challenges, prints/copies the /mcp
URL, then shows client, approval, task, idle and recovery events. Web apps cannot
be registered automatically. Follow the printed instructions. Temporary URLs
change; update connectors and reauthorize after rotation. No elevated grant moves
to another origin. Ctrl-C or the configured idle deadline stops the owned server
and tunnel; durable tasks keep running. Stop another terminal's server with:

```fish
bridge-dev down
bridge-dev status
bridge-dev tasks
```

Cloudflare Tunnel is an optional **third-party hosted relay**. Cloudflare and AI
vendors are separate trust boundaries and can observe traffic passing through
their services. OAuth authorizes access to Bridge; it does not make providers
trustworthy. Filesystem allowlisting and command allowlisting are not OS sandboxes.
Prompt injection is a serious risk when an AI reads untrusted content and later
uses write, execution or sudo tools. Remote dangerous access can compromise the
computer and all its data. See SECURITY.md and THREAT_MODEL.md.

| Mode | Capabilities |
| --- | --- |
| readonly, default | Read/list/search, process listing, task inspection/logs/waits |
| user | Also atomic file writes/edits, allowlisted literal argv, task mutations |
| sudo | Also unrestricted sudo_exec and privileged tasks, unless sudo_commands is explicitly configured |
| dangerous | Full account file paths, unrestricted argv, sudo, optional --shell |

Forbidden tools are absent from tools/list; effective permission is checked again
at dispatch. Preferred privileged mode is only a preference. Each startup requires
a typed phrase, except manually configured ack_privileged=true. The wizard and
installer never create that acknowledgment. Remote privileges require OAuth.
--sudo-for limits grants; expiry revokes queued/future dispatch and stale tools,
returning to the prior safe configured mode (otherwise readonly). Running jobs
continue. --ack-dangerous does not replace the typed phrase or manual exception.

Approval policies are none (automatic authorized calls), sudo (privileged calls),
write (writes/edits/exec/task mutation), and all. Terminal y approves one operation;
a approves its class for that authenticated session, within effective permissions.
No/timeout/headless input denies. HTTP returns unpredictable pending IDs rather
than waiting 120 seconds. Poll approval_status or task_wait, at most 25 seconds.
Mutations require request_key: reuse it only for a retry of the same logical call.
Private durable records provide at-most-once automatic dispatch. A crash after
dispatch may report unknown; never assume exactly-once or blindly retry a new key.

OAuth uses authorization code, PKCE S256, DCR, exact registered redirect URIs,
resource/scope binding, local six-digit match consent, CSRF protection, expiry,
rotating refresh tokens and revocation. Default callback hosts are claude.ai,
chatgpt.com and openai.com; deliberately configure additional exact hosts for
other remote OAuth clients. CIMD is optional and unimplemented; choose DCR or
automatic registration. --auth code retains the original local pairing flow.
Approved clients persist; inspect/revoke with clients list, clients revoke ID or
clients revoke-all. clientInfo names are self-reported, never verified providers.
Status reports authenticated identities and last activity, not continuous sockets.
Bridge cannot wake an AI conversation without a client request.

Local transports and registration:

```fish
bridge-dev stdio --roots /absolute/project --mode readonly
bridge-dev install codex --print
bridge-dev install codex
bridge-dev install claude-code
bridge-dev install claude-desktop
```

Native CLI changes require confirmation and preserve unrelated registrations.
Uninstall removes only receipt-matching Bridge entries. Desktop prints a snippet
for manual merge/removal. See docs/LOCAL_CLIENTS.md. Headless GUI stdio cannot
answer terminal approvals; select policies deliberately. For local HTTP development,
up defaults to loopback bearer authentication and readonly. Its 256-bit token file
is private; pass it only in Authorization headers, never URLs. up --oauth uses
terminal OAuth; up --detach uses a transient systemd user unit and denies required
interactive input. Detached pairing-code mode is refused to avoid log disclosure.

Tasks prefer transient systemd user units; detached owned workers are the fallback.
Logs and final results persist independently before systemd collection. Restarting
MCP never duplicates jobs. Stops use verified task control, graceful group shutdown,
then forced owned-group termination. task_logs uses byte offsets; completion events
use per-client acknowledgment cursors. Forgotten jobs must already be terminal.
Task status/log resources are available when reads are ungated; approve=all uses
the gated task tools instead. A force-killed worker/reboot can report lost/unknown
rather than fabricate an exit.
Privileged tasks use sudo -n systemd-run system units, with workers as the original
user. They must independently authorize sudo -n in that context; a terminal cache
may not transfer. Explicit scoped NOPASSWD may be necessary. sudoers preview/install
validates the exact preview with visudo and requires explicit installation consent.
Privileged background tasks currently require Linux systemd.

Technical file/output/search/log/deadline/concurrency/auth-state bounds are
configurable, with explicit dangerous-only unlimited values where supported.
Default file/output sizes are 1 MiB, task logs 16 MiB, search 200 results/10,000
visits/depth 32, HTTP bodies 2 MiB/concurrency 16. HTTP polling always caps at 25s.
Audit JSONL rotates at 4 MiB with three archives. It records paths and decisions,
not file contents, full command arguments, environment secrets or credentials.
Manage completed task storage and durable request receipts; dispatch tombstones
are retained to prevent old retries from rerunning. Technical abuse/concurrency
bounds are not monthly usage quotas. External providers have their own limits.

Quick/named/custom transports and trust are documented in docs/TUNNELS.md. The
Desktop Commander source review and adopted/deferred choices are in
[the pinned comparison](docs/DESKTOP_COMMANDER_COMPARISON.md). No TypeScript runtime
or source was imported. Go fits this project's small, on-demand binary and native
recoverable-task requirements; interactive PTYs/fuzzy edits/document conversion
were deliberately excluded from this phase.

ChatGPT compatibility depends on account/workspace and may be read-only. On
2026-11-11, official documentation was reviewed, but **no real ChatGPT account,
Plus write access, Claude account or public tunnel was tested**. OAuth success is
not proof of write-tool support. Use the four-tool compatibility probe and record
actual results in MANUAL_TEST.md; ChatGPT is not a release blocker. Current
[OpenAI instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server)
use Plugins / Add custom MCP server; account-specific older Apps/Developer mode
labels may differ. Select DCR, not CIMD.

Run make check, make fuzz, make cross and make coverage. TEST_REPORT.md separates
local proof from remaining human checks. MANUAL_TEST.md contains exact Fish
commands. Completions are under completions/; they are never installed automatically.

For complete cleanup, run down, inspect/stop desired tasks, revoke clients and
uninstall owned registrations; remove manual Desktop entries separately. Only after
all jobs finish, archive/remove Bridge's config/state and binary yourself. Do not
remove state while jobs run. Named Cloudflare tunnel/DNS/account cleanup is separate
native provider administration. No permanent Bridge service is installed.

Naming lives in internal/identity. Change Name there, go.mod and Go import prefixes
mechanically together; review binary/completion/Makefile labels and migration paths.
Keep old XDG state intact and migrate deliberately. Schema-v1 changes create a
private .pre-v2-* backup; restore that backup explicitly and run config check.
Never treat an invalid file as permission to load a more privileged default.
MIT licensed; source remains local with no Git remote or publication.
