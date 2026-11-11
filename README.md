> Phase 2 is being implemented incrementally. Current verification is in
> REQUIREMENTS.md and TEST_REPORT.md. Intentional replacements of Phase 1
> restrictions are listed in docs/SUPERSEDED_RESTRICTIONS.md. Local milestone
> commits are authorized; remotes, push, publication and permanent services are not.

# Bridge Development

A free, self-hosted Go MCP server for controlled filesystem access, argv
execution, and durable background tasks. **The project has no final name.**
`bridge-dev` and `github.com/kmanisk/bridge-dev` are temporary identities.

Development software: tested locally on Linux amd64; not security-audited or
certified OAuth-conformant. Codex stdio is the primary local target, Claude
Pro/Max the primary web target. No GitHub repository, publication, installed
service, or public endpoint is created by the project setup.

## Build and installation

Requires Go 1.25 or later (development verification uses Go 1.27.3), a Linux
kernel with openat2 (5.6+) and mounted `/proc`, or macOS. Execution also needs
`/bin/ps`; systemd user services are preferred for tasks on Linux. cloudflared
and sudo/visudo are optional external executables, never bundled or installed
automatically. Runtime requires no Go installation.

```sh
make build
./bin/bridge-dev doctor
./bin/bridge-dev config check
```

The binary is `bin/bridge-dev`. For an optional manual installation, copy it to
a directory you own on PATH. `make cross` builds Linux/macOS amd64/arm64 with
`CGO_ENABLED=0`; Linux binaries are static. macOS binaries still use platform
system libraries. Native macOS and Linux arm64 execution is not verified here.

## Local stdio

Start from a deliberately small directory containing no credentials:

```sh
./bin/bridge-dev stdio --roots /absolute/path/to/workspace
```

An MCP client launches this command and communicates through stdin/stdout.
Diagnostics go only to stderr. For user mode, explicitly allow executables:

```sh
./bin/bridge-dev stdio --mode user --roots /absolute/path/to/workspace \
  --allow-commands /usr/bin/printf,/usr/bin/sleep
```

Direct sudo/doas/pkexec argv is rejected in ordinary exec; use the explicit
local privileged path. This guard does not sandbox an allowlisted interpreter.
Arguments are literal argv entries. No shell expansion occurs. An explicitly
allowlisted shell/interpreter or general-purpose program has all of its normal
capabilities: **execution is not an OS sandbox**. Roots constrain filesystem
tools and initial working directory, not file arguments or child syscalls.

## Local HTTP

```sh
./bin/bridge-dev up --roots /absolute/path/to/workspace --port 8765
```

This runs in the foreground on `http://127.0.0.1:8765/mcp`, with readonly
authorization by default. A generated 256-bit token is stored mode 0600 in
`~/.local/state/bridge-dev/token` (or configured state directory). HTTP requests
require `Authorization: Bearer TOKEN`. Never put access tokens in URLs, paste
them into model prompts, or check them into files in an allowed root.
`/healthz` returns only `ok`. HTTP metadata and OAuth flow endpoints are public
when OAuth is enabled; authenticated MCP operations remain protected.

The official SDK StreamableHTTPHandler uses stateless JSON responses; the
simple request/response path does not depend on SSE. Idle timeout defaults to
30 minutes, and active requests prevent idle shutdown. Requests are limited to
2 MiB, 16 concurrent handlers, and bounded network timeouts. Host and Origin
must exactly match the loopback origin or the explicitly configured issuer.
No non-loopback listener is supported.

```sh
./bin/bridge-dev status
./bin/bridge-dev down
```

`down` gracefully stops only the HTTP instance owning the same state directory.
It does not terminate tasks. Ctrl-C stops a foreground server and its owned
tunnel. Use `tasks stop ID` for each running task to shut down all workloads.
There is no persistent service or automatic startup to disable.

## OAuth and explicit tunnels

```sh
./bin/bridge-dev up --oauth --roots /absolute/path/to/workspace --port 8765
# Only when deliberately choosing to expose an authenticated development server:
./bin/bridge-dev up --oauth --tunnel cloudflared \
  --roots /absolute/path/to/workspace
```

The second command starts an outbound Quick Tunnel and prints its HTTPS `/mcp`
URL. It never starts automatically. The tunnel process belongs to this server
and is stopped on shutdown; unrelated cloudflared processes are untouched.
Cloudflare terminates TLS: there is no hosted application relay or telemetry,
but choosing this tunnel trusts Cloudflare with transit traffic and uses its
infrastructure. No tunnel was publicly launched during automated testing.

OAuth uses authorization-code flow with S256 PKCE; short-lived, single-use
local human consent and authorization codes; exact registered redirect URIs;
CSRF-bound consent; resource-bound tokens; 15-minute access tokens; rotating
7-day refresh tokens with replay-family revocation; and revocation. The local
terminal displays the client, callback, permission scope, and a two-minute
consent code. Enter it only into the matching browser consent page, never into
a model conversation. Current public clients can register with RFC 7591
`token_endpoint_auth_method=none`. Confidential clients can register with `client_secret_basic`; issued client
secrets are returned once and stored only as hashes. Client ID metadata
documents are not implemented or advertised. Choose automatic registration
in clients that offer multiple registration approaches.

OAuth metadata is available at `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp`. Issuer and mode changes fail closed
against existing OAuth state. Quick Tunnel hostnames change; use a new
`--state-dir` for each hostname, then reconnect clients. For stable local OAuth,
use a fixed port. Tokens are persisted as hashes in private local storage.
Local bearer administration remains available for `down`, separate from OAuth.

## Permissions

| Mode | Available tools |
| --- | --- |
| readonly (default) | fs_read, fs_list, fs_search, search, fetch, proc_list, task_list, task_status, task_logs, task_wait |
| user | readonly tools plus fs_write, fs_edit, exec, task_start, task_stop, task_restart, task_forget |
| sudo (local only) | user tools plus sudo_exec and explicitly requested privileged tasks |
| dangerous (local only) | unrestricted filesystem paths and executable allowlist bypass; explicit `--ack-dangerous` required |

Forbidden tools are absent from `tools/list`. HTTP refuses sudo and dangerous
modes before opening a listener. Dangerous mode still honors explicit command
denies and sudo command allowlists. No implicit shell tool exists; a shell may
be invoked by explicit argv. File size, special-file and atomic-write checks
remain in effect in every mode. These are supported-operation limits, not a
claim of unrestricted device access.

File reads return UTF-8 text, or an explicit `{encoding: "base64", content: ...}`
object for non-UTF-8 data. Writes accept optional `encoding="base64"` for binary
content; the decoded 1 MiB limit still applies. Atomic writes preserve ordinary
permission bits, not inode identity, ownership, ACLs or extended attributes.

Sudo always uses `/usr/bin/sudo -n -- ...`, with a separate executable allowlist.
No password prompt, storage or password logging exists. Preview a narrowly
scoped no-argument rule (validated with `visudo -cf`) without installing it:

```sh
./bin/bridge-dev sudoers preview --sudo-commands /usr/bin/id
```

Writing or installing sudoers is a separate manual user action. Tests never
run real sudo or modify sudoers.

## Configuration

Default file: `~/.config/bridge-dev/config.toml`. See
[config.example.toml](config.example.toml). Unknown TOML fields, invalid modes,
and missing explicit config files are errors. An absent default config retains
readonly mode. Precedence: CLI flags > environment > config file > defaults.

Supported environment variables use `BRIDGE_DEV_`: `CONFIG`, `MODE`, `ROOTS`,
`PORT`, `IDLE_TIMEOUT`, `TUNNEL`, `STATE_DIR`, `ALLOW_COMMANDS`, `DENY_COMMANDS`,
`SUDO_COMMANDS`, `ISSUER`, `TASK_BACKEND`, `OAUTH`, `PROBE`, `ACK_DANGEROUS`.
List variables/flags use commas; booleans use `true` or `false`. `env_allow` is a
TOML list; no request-supplied environment exists. Loader variables are excluded,
and PATH is fixed to `/usr/bin:/bin`. XDG config/state directories are supported.
State directories must be private (0700), and token files must be 0600.

## Task lifecycle and events

Each task has a random ID, original argv/cwd, timestamps, worker PID and process
identity, systemd unit identity where applicable, a log path, final exit code,
signal status and final CPU/peak-memory usage. Metadata lives under
`~/.local/state/bridge-dev/tasks/`. Linux prefers transient systemd user units
with `--collect`; the independent worker durably writes completion before unit
collection. Fallback workers detach into new sessions. Neither depends on MCP
remaining connected. No task daemon is installed.

```sh
./bin/bridge-dev tasks
./bin/bridge-dev tasks status ID
./bin/bridge-dev tasks logs ID
./bin/bridge-dev tasks stop ID
```

Use MCP `task_start` to launch; `task_restart` creates a new ID under current
policy. `task_forget` removes only known terminal tasks. `task_logs` accepts
`offset` and returns `next_offset` plus `eof`; chunks are 64 KiB and total logs
are capped at 16 MiB. `task_wait` defaults to 25 seconds and rejects larger
waits. Stop requests go to the task's private control file: the worker sends
TERM to its owned process group, then KILL if needed. No task stop signals a
PID read from stale metadata. Reboot or worker loss reports `lost`, never an
invented successful exit. Live systemd cgroup CPU/memory is reported when available; final command
CPU/peak-memory usage is recorded on normal completion. Detached/macOS live
resource sampling is unavailable in this build. Task count and aggregate retained task disk
usage are not globally capped; use `task_forget` to prune completed records.

Add a stable `client_id` to tool calls for compact pending completion summaries.
The server namespaces it by authenticated identity. Send the returned
`completion_cursor` as `ack` to acknowledge through that event. Summaries survive
server restart and stop repeating after acknowledgment; without acknowledgment,
redelivery is intentional. Completion records are independent of task metadata and remain pending even
after a task is forgotten. Cursors use a durable monotonic sequence, independent
of wall-clock changes.
An MCP server cannot independently wake a ChatGPT conversation or cause an AI
response without a client request.

## Security and limitations

Read [SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md). Files and
websites may contain prompt injections. Tool annotations help clients decide
presentation/confirmation but never grant permissions. Do not put credentials,
sensitive logs, or the server's private state inside allowed roots. Another
process with your OS account, root, or a privileged task is outside the security
boundary. Private state is not encrypted at rest; use disk encryption as needed.

Linux rejects symlinks, special files and nested mount crossings with openat2.
Writes use atomic replacement and reject existing hard links. Internal symlinks
are also rejected on Linux (except explicit dangerous mode); this is stricter
than ordinary filesystem behavior. macOS uses Go's traversal-resistant os.Root;
its backend has not been runtime-tested and does not defend against concurrent
device creation/mount changes by the same account/root. Existing open directory
capabilities remain tied to their inode if renamed. Unsupported platforms fail
to build rather than silently selecting an unsafe path implementation.

No hosted telemetry, analytics, or external reporting. Audit JSONL contains
operation metadata, identities, mode, result, duration, task ID and exit status;
no contents, argv, environment, passwords or tokens. Audit rotation retains the
active 4 MiB log plus three archives. Command output and original task argv are
local task data, not audit logs; they can contain sensitive data if commands
print or receive it. Do not pass passwords/tokens as argv.

## Client compatibility and the ChatGPT probe

Compatibility review date: **2026-11-11**. Claude Pro/Max and ChatGPT web have
not been tested against an actual account in this development run. ChatGPT
support depends on plan/workspace/UI settings and may be read-only. No claim is
made that this user's Plus plan permits custom MCP writes. Official guidance
can differ across product surfaces. The [OpenAI Help Center](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
and [Claude connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
are reference points; account behavior is the deciding evidence.

`up --probe` exposes exactly `probe_read` (readOnlyHint=true), `probe_write`
(a harmless dummy with readOnlyHint=false), and read-only `search`/`fetch`.
The dummy tool changes no user data and is the only probe exception to the
readonly registry; ordinary write/exec tools remain absent. `search` and `fetch`
are thin filesystem aliases, not a claim of full ChatGPT deep-research result
schema support. Probe connector creation, discovery, read behavior and write
confirmation/blocking separately. Follow [MANUAL_TEST.md](MANUAL_TEST.md).
Bearer-header configuration varies by client; OAuth is the remote path.

## Tests and renaming

```sh
make check
make fuzz
make cross
```

Install staticcheck only into this project if needed:
`GOBIN="$PWD/.tools" go install honnef.co/go/tools/cmd/staticcheck@v0.8.2`
(the exact tested tool version is in TEST_REPORT.md). All integration tests use
isolated temporary directories and the actual built binary with official SDK
clients. See [TEST_REPORT.md](TEST_REPORT.md), [NOTES.md](NOTES.md),
[MANUAL_TEST.md](MANUAL_TEST.md), and [ARCHITECTURE.md](ARCHITECTURE.md).

To rename, change `internal/identity` constants; rename `cmd/bridge-dev`, module
and import prefixes (`go mod edit -module ...` plus mechanical import update);
change the Makefile binary/command path and `identity.EnvPrefix`,
examples, protocol test helper paths, and docs. Persistent default state/config
locations derive from `identity.Binary`. Preserve/migrate old state deliberately;
OAuth issuer changes invalidate credentials. No repository name is assumed.
