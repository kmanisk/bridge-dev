# Fish verification checklist

Run from the checkout. Examples are Fish and are syntax-checked by make fish-check;
that check never executes them. Automated tests use temporary directories and fake
sudo/tunnel/client binaries. The commands below are deliberate human actions.
Never select your home as a dangerous-mode test root. External cases remain
unverified until you record actual results, date, app version, account/workspace
and mode. Do not paste credentials into this document.

## 1. Build and isolated fixture

```fish
cd ~/Projects/bridge-dev
make build
set -gx PATH $PWD/bin $PATH
set -gx BRIDGE_FIXTURE (mktemp -d)
mkdir -p $BRIDGE_FIXTURE/root $BRIDGE_FIXTURE/config $BRIDGE_FIXTURE/state
chmod 700 $BRIDGE_FIXTURE/config $BRIDGE_FIXTURE/state
printf 'hello bridge\n' > $BRIDGE_FIXTURE/root/hello.txt
set -gx XDG_CONFIG_HOME $BRIDGE_FIXTURE/config
set -gx XDG_STATE_HOME $BRIDGE_FIXTURE/state
bridge-dev doctor
bridge-dev config check --roots $BRIDGE_FIXTURE/root
```

Expected: built binary, tool inventory, readonly config valid. These environment
settings apply only to this terminal; use the same fixture variables in another
terminal for HTTP/task checks. Save the fixture path privately, not credentials.

## 2. Codex stdio and readonly tools

```fish
set -gx CODEX_HOME $BRIDGE_FIXTURE/codex
mkdir -p $CODEX_HOME
codex mcp add bridge-fixture -- (realpath bin/bridge-dev) stdio --roots $BRIDGE_FIXTURE/root --mode readonly
codex mcp get bridge-fixture --json
codex
```

In Codex use /mcp and ask it to call fs_read on hello.txt and list tools. Expected:
read succeeds; fs_write, exec, sudo_exec and task_start are absent. Closing Codex
stops stdio without stopping independent tasks. No real existing Codex config is
modified. Native registration without an AI conversation is automated separately.

```fish
go run ./scripts/client --binary ./bin/bridge-dev --tool fs_read --args '{"path":"hello.txt"}' -- --roots $BRIDGE_FIXTURE/root --mode readonly
```

Expected: hello bridge. Ask fs_read ../outside or an external symlink: refusal.

## 3. User execution and deduplication

```fish
go run ./scripts/client --binary ./bin/bridge-dev --tool exec --args '{"argv":["/bin/echo","literal-$HOME"],"cwd":".","request_key":"manual-echo-one"}' -- --roots $BRIDGE_FIXTURE/root --mode user --allow-commands /bin/echo --approve none
```

Expected: literal-$HOME, exit 0, no shell expansion. Repeat with the same key and
state: cached result, no dispatch. Change argv under that key: invalid_request.
Use a fresh unique key only for a genuinely new operation. Disallowed /bin/sh
without explicit allowlisting must fail. Tests for crash after dispatch expect
unknown and no rerun; reconcile using task/process/file evidence.

## 4. Task start/status/logs/stop

```fish
go run ./scripts/client --binary ./bin/bridge-dev --tool task_start --args '{"argv":["/bin/sleep","120"],"cwd":".","request_key":"manual-task-one"}' -- --roots $BRIDGE_FIXTURE/root --mode user --allow-commands /bin/sleep --approve none
bridge-dev tasks
set -gx TASK_ID REPLACE_WITH_RETURNED_TASK_ID
bridge-dev tasks status $TASK_ID
bridge-dev tasks logs $TASK_ID
bridge-dev tasks stop $TASK_ID
```

Expected: unique durable ID, running metadata, bounded logs, graceful stopped
result. task_logs offset=next_offset continues without duplicating bytes.
A terminal/completed task can be restarted only as a new authorized task; retries
of the original start key return its original result. Do not stop other jobs.

## 5. Task survives server restart/disconnect

Start another 120s task with a fresh request_key in step 4. The SDK client exits
its stdio server immediately afterward. Query status in a new CLI or MCP session.
Expected: same task still running. Start HTTP below, stop it with down, then check
the same ID again. Task survives. Wait for final exit, restart MCP and inspect it:
exit status remains even after systemd collects its transient unit. Completion
cursors acknowledge events once; polling after acknowledgment does not repeat them.

## 6. Local HTTP MCP

In terminal A:

```fish
bridge-dev up --roots $BRIDGE_FIXTURE/root --port 8765 --idle-timeout 10m
```

In terminal B, set BRIDGE_FIXTURE to the same directory and XDG_STATE_HOME to its
state directory before these commands:

```fish
set -gx XDG_STATE_HOME $BRIDGE_FIXTURE/state
curl -i http://127.0.0.1:8765/healthz
go run ./scripts/client --url http://127.0.0.1:8765/mcp --token-file $BRIDGE_FIXTURE/state/bridge-dev/token
bridge-dev status
```

Expected: health says readonly without paths/secrets; SDK tools/list succeeds
with a header token. status shows mode/URL/last activity/audit and idle deadline.
No token is copied into a URL, shell argument, report or audit entry.

## 7. Invalid authentication and Host

```fish
curl -i -X POST http://127.0.0.1:8765/mcp -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -i http://127.0.0.1:8765/mcp -H 'Authorization: Bearer deliberately-invalid'
curl -i http://127.0.0.1:8765/healthz -H 'Host: untrusted.example'
bridge-dev down
```

Expected: 401 with protected-resource challenge for missing/bad auth, 403 for
invalid Host. Host denial audit is rate limited. No sensitive health data.

## 8. OAuth PKCE and terminal consent

Automated full PKCE/refresh/revoke checks use actual built HTTP servers and
isolated state, with the legacy pairing flow. Scripted terminal-consent tests use
real HTTP requests and a fake tunnel origin without exposing the Internet:

```fish
go test -count=1 ./integration -run 'TestBuiltOAuthHTTP|TestBuiltPrivilegedOAuthHTTP'
go test -count=1 ./internal/auth ./internal/connect -run 'TestTerminal|TestClientRevocation|TestPrivilegedTokens|TestTunnelRotation'
```

Expected: pass; fake sudo only. For human OAuth use connect below. Browser shows
six digits; confirm only if terminal client ID/name/redirect host/mode/code match.
N denies; no response expires after 60s. Redirects must match a registered URI
exactly and configured host allowlist. DCR/automatic registration is required;
CIMD is not supported. Refresh rotates; revoked/expired credentials cannot call.

## 9. Explicit real Quick Tunnel and wizard

This section intentionally exposes the selected fixture through Cloudflare.
Run it only after deciding to use that third-party relay. No automated test does so.

```fish
bridge-dev connect --roots $BRIDGE_FIXTURE/root --mode readonly --idle-timeout 10m
```

Expected: missing cloudflared gives an install command and exits; no automatic
package installation. First run asks choices and saves private TOML. Choose
readonly, write or all approvals as desired, and cloudflared. Only after verified
health/discovery/challenge is the HTTPS /mcp URL printed/copied. Bounded retry with
exponential backoff accommodates transient DNS and edge propagation delays (default 120s,
with backoff capping at 5s), and scoped fallback resolvers (1.1.1.1, 8.8.8.8) prevent
local stub resolver negative caching stalls.
If verification fails, a structured diagnostic block is printed reporting stage,
hostname, local port, elapsed duration, HTTP status, network error category, child
tunnel state, and sanitized error. Later connect uses saved values; --reconfigure asks again. A real tunnel requires manual evidence.
Ctrl-C stops owned HTTP/tunnel processes, preserving tasks. tunnel setup can guide
a named tunnel (account/domain/native browser login), or select quick again. Do
not perform named DNS/account operations merely to run automated tests.

## 10. Claude web account

Official instructions reviewed 2026-11-11:
[custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
Use Customize / Connectors / Add custom connector; older UI may show Settings /
Connectors. Paste the printed HTTPS /mcp URL, select OAuth and automatic/DCR client
registration, then connect. Leave static client secrets blank unless deliberately
pre-registered. Complete terminal matching-code consent. Web apps cannot be
registered automatically. In a conversation explicitly ask for Bridge fs_read.
Expected evidence: authenticated client ID/last seen, self-reported name separately,
first tool event and correct file result. Provider identity is not cryptographically
verified by clientInfo. Record the actual account result; none is assumed here.

## 11. ChatGPT web compatibility probe

Create a separate readonly compatibility server with one harmless read, one dummy
write and read-only search/fetch. Stop the regular connect first. This command
intentionally starts a public tunnel only when the human runs it:

```fish
bridge-dev up --oauth --probe --approve none --roots $BRIDGE_FIXTURE/root --mode readonly --tunnel cloudflared --port 8765
```

Use its verified public URL. Current official
[OpenAI instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server)
reviewed 2026-11-11 say Plugins / + / Add custom MCP server. Account-specific older
UI: Settings / Apps / Advanced settings / Developer mode / Create app. Select
OAuth with DCR/automatic registration. Complete terminal consent. Add/select the
app in a conversation; explicitly invoke probe_read, then probe_write with
request_key="probe-write-one", then search and fetch on hello.txt.

Record separately: connector creation, tools/list visible, read without provider
prompt, dummy-write confirmation or block, tool result, auth consent and reconnect
after URL change. The dummy write never changes user files. OAuth success alone
proves neither listing nor write capability. Never infer plan access from local
SDK tests. No ChatGPT account result was tested in this implementation session.

## 12. Current ChatGPT plan/workspace restrictions

In the actual account check subscription/workspace and whether the custom MCP UI
exists. Complete step 11 and record the exact write outcome. Plus full write access
is **unverified** and may be read-only or unavailable. Restrictions may come from
plan/workspace/security policy; they are compatibility findings, not server bugs.
Do not change subscriptions or workspace security controls for this checklist.
Claude web remains the primary remote target; ChatGPT does not block release.

## 13. Approvals, sudo and dangerous safety

Safe scripted checks only:

```fish
go test -count=1 ./internal/approval ./internal/privilege ./internal/tasks ./internal/mcpserver
```

These use temporary PATH sudo shims, never real sudo. For ordinary interactive
approval, connect --mode user --approve write with a fixture root and allowlisted
/bin/echo. Ask the AI for a fresh-key fs_write or exec. Expected: pending ID,
terminal exact path/argv/client/cwd/mode, y/N/a, then own-session polling. N yields
"denied by user"; timeout 120s denies; a covers only that session/class. In detached
mode gated requests deny. A retry never executes an operation twice.

Real privileged checks require an explicit human decision and are NOT automated.
Use only the harmless /usr/bin/id command and fixture paths:

```fish
bridge-dev connect --roots $BRIDGE_FIXTURE/root --mode sudo --approve sudo --sudo-for 2m
```

Expected: loud banner and typed AUTHORIZE SUDO each startup unless you deliberately
manually set ack_privileged=true. sudo itself owns the TTY password prompt; never
send a password through MCP. Ask sudo_exec /usr/bin/id with cwd fixture and a fresh
request key. At grant expiry, new and pending privileged calls deny; running jobs
continue. A systemd worker may lack this terminal's cache: it must fail clearly
rather than prompt; scoped NOPASSWD is a separate explicit administrative choice.

Dangerous testing is a separate explicit authorization. Use a fixture-only test
file and harmless echo; do not use home as a root or execute destructive commands.

```fish
bridge-dev connect --roots $BRIDGE_FIXTURE/root --mode dangerous --approve all --sudo-for 2m --shell
```

Expected: AUTHORIZE DANGEROUS, prominent compromise warning, unrestricted path/argv
capability and optional shell tool, audit still active. The root flag does not jail
dangerous access. Remote privileged modes without OAuth must refuse. Never execute
sudoers install as part of tests. A deliberate preview can use:

```fish
bridge-dev sudoers preview --sudo-commands /usr/bin/id
```

Expected: validated no-argument rule; no file installed. Actual install is a separate
explicit terminal confirmation. Broad executable warnings must be taken seriously.

## 14. Audit, status and local installation

```fish
bridge-dev status
bridge-dev clients list
bridge-dev watch
```

Expected: identities and last activity, effective mode, task count/deadlines and last
ten audit lines; watch stops with Ctrl-C. Inspect audit for requested/resolved paths,
reason codes, pending/approved/denied/completed transitions and exit/task IDs.
It must omit tokens/codes/passwords, full argv, sensitive environment and file contents.
Client revoke ID or revoke-all invalidates future calls, including queued approvals.
To test native local registration without changing your actual user profiles, keep
CODEX_HOME from step 2 and use install codex --print, then install codex and confirm.
Uninstall codex removes only its matching receipt. Claude Code actual installation
is manual (binary absent during automated verification); Desktop prints a snippet.

## 15. Idle, detach, down and cleanup

```fish
bridge-dev up --roots $BRIDGE_FIXTURE/root --idle-timeout 5s --port 8765
```

Expected: idle exit in about five seconds; active requests/dispatched work finish.
Pending prompts alone do not keep it alive forever. In another deliberate check:

```fish
bridge-dev up --detach --roots $BRIDGE_FIXTURE/root --idle-timeout 1m
bridge-dev status
bridge-dev down
```

Expected: transient systemd user unit, no enable/startup service. Terminal-required
requests deny. Missing http.json is recovered via the second ownership record;
stale/unverifiable state never causes blind PID kills. A totally missing record
with a held instance lock reports partial and refuses unsafe stopping.

After stopping all chosen fixture tasks and servers, remove only test-owned client
registrations and data. Review the fixture path before deleting anything:

```fish
codex mcp remove bridge-fixture
bridge-dev uninstall codex
bridge-dev clients revoke-all
bridge-dev tasks
printf 'Fixture retained for review: %s\n' $BRIDGE_FIXTURE
```

If there is no installer receipt, uninstall correctly refuses removal; do not
bypass it by deleting unrelated client registrations. Archive/remove the fixture
only after confirming every task has ended. Restore migrated configuration with
an explicitly selected private .pre-v2-* backup, then config check; never overwrite
an active configuration blindly. Native named-tunnel/DNS deletion is separate.

## 16. Recovery, coverage, platforms and account evidence

```fish
make check
make fuzz
make cross
make coverage
fish -n completions/bridge-dev.fish
```

Expected: green tests/vet/race/staticcheck/Fish syntax, path fuzz, four CGO-free
release builds, coverage/unit-functions.txt and coverage/subprocess-functions.txt.
Crash tests target only their own subprocesses and report unknown without rerun.
No public relay, actual sudo or permanent service is used by make check.

| Required human environment | Evidence to record; currently unverified |
| --- | --- |
| Real Claude account | OAuth, DCR, tool discovery, reads/writes/approvals and reconnect |
| Real ChatGPT account/workspace | Creation/list/read/dummy-write confirmation or block; current plan |
| Actual Cloudflare | TLS/public reachability, disconnect/restart/new hostname, named setup if selected |
| macOS machine | Native build/run, os.Root race/device checks, clipboard, stdio/HTTP/tasks |
| Linux ARM64 machine | Native execution, process identity and filesystem/task behavior |
| User-controlled sudo | Foreground TTY authentication, worker cache failure, deliberate scoped sudoers |
| Explicit dangerous authorization | Banner/phrase, mode expiry, safe fixture path/argv/shell and audit |

Do not mark these complete based on compilation, an OAuth unit test or a
self-reported client name. Bridge cannot independently wake a web AI conversation.

## Final sprint browser OAuth regression (2026-11-11)

Automated guard-to-OAuth tests use scripted consent and a local HTTPS-origin proxy;
they do not approve the running public server. For an actual account test:

```fish
bridge-dev connect
```

Use the newly printed /mcp URL in the ChatGPT custom connector or Claude connector,
select automatic/DCR registration and click Connect. Web app registration is manual.
If Bridge is already running in the dedicated session, attach instead of starting
a second instance:

```fish
tmux attach -t bridge-connect
```

Expected: GET /authorize with the canonical public Host reaches the six-digit
consent page without requiring an Origin header. Its response has
Referrer-Policy: same-origin. Compare browser/terminal code and client/redirect/scope;
type y yourself within 60 seconds. Auto-polling POST /authorize keeps the same-origin
Origin. The validated callback carries code, original state and iss; the client
exchanges with S256 PKCE and initializes MCP. Request fs_list, fs_read hello.txt,
search and fetch in an isolated harmless directory. Record actual client/account,
date, consent, callback, initialize, tools/list and read outcomes separately.

Deny with n or wait past 60 seconds: access_denied returns to the validated callback
with original state and iss and no code. Reconnect for a new consent request.
A wrong Host is 403, a present foreign/null unsafe Origin is 403, invalid callback
or CSRF is 400, missing MCP authorization is 401. Direct browser /mcp unauthorized
is expected and is not the OAuth navigation failure. Never paste callback URLs,
codes, cookies or tokens into reports or an AI conversation.

Try a wizard typo such as yes at Mode: it explains the four choices and repeats
Mode without discarding valid roots. Discovery/health probes must not keep the
server alive past idle timeout. Existing/partial instances must be reported and
preserved. During consent/approvals, task events must wait until the prompt ends.
The optional dashboard has no command/UI implementation and is not a passed test.
