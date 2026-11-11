# Manual test checklist

Run shell blocks in **bash**, from the project root. These are user-run checks;
the agent did not launch a public tunnel or connect a web account. All test data
must stay in the temporary workspace. Do not use home as a test root, run real
sudo, alter sudoers, or give a destructive command to an AI.

## Preparation

```sh
make build
export BIN="$PWD/bin/bridge-dev"
export LAB="$(mktemp -d -t bridge-dev-manual.XXXXXXXX)"
chmod 700 "$LAB"
mkdir -m 700 "$LAB/work" "$LAB/state" "$LAB/config"
export XDG_CONFIG_HOME="$LAB/config"
# Clear product overrides only in this disposable test shell.
while IFS= read -r name; do unset "$name"; done < <(compgen -v BRIDGE_DEV_)
: > "$LAB/config/empty.toml"
chmod 600 "$LAB/config/empty.toml"
export BRIDGE_DEV_CONFIG="$LAB/config/empty.toml"
printf 'safe test content\n' > "$LAB/work/hello.txt"
"$BIN" doctor --state-dir "$LAB/state" --roots "$LAB/work"
"$BIN" config check --state-dir "$LAB/state" --roots "$LAB/work"
```

Expected: doctor JSON, config valid/readonly. No persistent service installed.
The test client below uses the official Go MCP SDK. Arguments after `--` go to
the server. Never supply the real token through `--args` or a model prompt.

## 1. Codex stdio MCP

```sh
export CODEX_HOME="$LAB/codex"
mkdir -m 700 "$CODEX_HOME"
codex mcp add bridge-dev-test -- "$BIN" stdio \
  --roots "$LAB/work" --state-dir "$LAB/state"
codex mcp get bridge-dev-test --json
# Optional interactive check, with your own deliberate isolated authentication:
codex
```

Expected: registration lists the correct binary and stdio arguments. If starting
the isolated Codex UI, use `/mcp` and ask it to read only `hello.txt`. A fresh
CODEX_HOME has no login; do not copy your regular config/auth into it as part of
automation. A PATH-alias warning for temporary Codex homes can occur without
registration failure. The automated run tested registration/get/removal, and
SDK stdio calls; it did not make a Codex model/API request.

```sh
codex mcp remove bridge-dev-test
unset CODEX_HOME
```

Expected: only the isolated registration is removed.

## 2. Filesystem read-only access

```sh
go run ./scripts/client --binary "$BIN" -- --roots "$LAB/work" --state-dir "$LAB/state"
go run ./scripts/client --binary "$BIN" --tool fs_read \
  --args '{"path":"hello.txt"}' -- --roots "$LAB/work" --state-dir "$LAB/state"
go run ./scripts/client --binary "$BIN" --tool fs_read \
  --args '{"path":"../outside"}' -- --roots "$LAB/work" --state-dir "$LAB/state"
printf 'outside\n' > "$LAB/outside"
ln -s "$LAB/outside" "$LAB/work/escape"
go run ./scripts/client --binary "$BIN" --tool fs_read \
  --args '{"path":"escape"}' -- --roots "$LAB/work" --state-dir "$LAB/state"
```

Expected: tools/list has readonly tools, search and fetch; no fs_write/exec/sudo.
The first read returns the fixture. Traversal and symlink reads fail, without
returning outside contents. Linux also rejects internal symlinks.

## 3. User-mode execution

```sh
bridge_call() {
  go run ./scripts/client --binary "$BIN" --tool "$1" --args "$2" -- \
    --mode user --roots "$LAB/work" --state-dir "$LAB/state" \
    --allow-commands /bin/echo,/bin/sleep --task-backend auto
}
ARGS="$(python3 -c 'import json,os;print(json.dumps({"argv":["/bin/echo","literal $(not-expanded)"],"cwd":os.environ["LAB"]+"/work"}))')"
bridge_call exec "$ARGS"
bridge_call exec '{"argv":["/bin/rm","anything"],"cwd":"."}'
```

Expected: literal output, exit code zero. Non-allowlisted executable fails before
execution. No shell expansion occurs. Do not add a shell for routine tests.

## 4. Task start/status/stop

```sh
ARGS="$(python3 -c 'import json,os;print(json.dumps({"argv":["/bin/sleep","60"],"cwd":os.environ["LAB"]+"/work"}))')"
TASK_JSON="$(bridge_call task_start "$ARGS")"
printf '%s\n' "$TASK_JSON"
TASK_ID="$(printf '%s' "$TASK_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["structuredContent"]["data"]["id"])')"
"$BIN" tasks --state-dir "$LAB/state"
"$BIN" tasks status "$TASK_ID" --state-dir "$LAB/state"
"$BIN" tasks logs "$TASK_ID" --state-dir "$LAB/state"
```

Expected: random task ID, running status, worker identity, systemd transient unit
when available, and empty sleep output. To stop:

```sh
"$BIN" tasks stop "$TASK_ID" --state-dir "$LAB/state"
"$BIN" tasks status "$TASK_ID" --state-dir "$LAB/state"
```

Expected: stopped and a durable signal/exit result, not an arbitrary PID kill.

## 5. Task surviving server restart

Each `bridge_call` starts and closes a separate MCP stdio server. Repeat task
start as above, then obtain status from a new process:

```sh
TASK_JSON="$(bridge_call task_start "$ARGS")"
TASK_ID="$(printf '%s' "$TASK_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["structuredContent"]["data"]["id"])')"
bridge_call task_status "{\"id\":\"$TASK_ID\"}"
"$BIN" tasks stop "$TASK_ID" --state-dir "$LAB/state"
go test ./integration -run TestDurableTasks -v
```

Expected: task remains running after original server closes. Automated test
covers detached/systemd restart, exit 7 after unit collection, log continuation,
completion acknowledgment and cancellation. It uses temporary shell fixtures
only for controlled test generation. No real user task is stopped.

## 6. Local HTTP MCP

```sh
"$BIN" up --roots "$LAB/work" --state-dir "$LAB/state" \
  --port 8765 --idle-timeout 5m &
HTTP_PID=$!
curl --fail http://127.0.0.1:8765/healthz
"$BIN" status --state-dir "$LAB/state"
go run ./scripts/client --url http://127.0.0.1:8765/mcp \
  --token-file "$LAB/state/token"
go run ./scripts/client --url http://127.0.0.1:8765/mcp \
  --token-file "$LAB/state/token" --tool fetch --args '{"id":"hello.txt"}'
```

Expected: loopback-only URL, readonly registry, successful read. Token is never
printed. Inspect file permissions: `stat -c '%a' "$LAB/state/token"` gives 600
on Linux (`stat -f '%Lp' ...` on macOS).

## 7. Invalid authentication

```sh
curl -i http://127.0.0.1:8765/mcp
curl -i -H 'Authorization: Bearer deliberately-invalid' http://127.0.0.1:8765/mcp
curl -i -H 'Host: evil.example' http://127.0.0.1:8765/healthz
curl -i -H 'Origin: https://evil.example' http://127.0.0.1:8765/healthz
"$BIN" down --state-dir "$LAB/state"
wait "$HTTP_PID"
```

Expected: 401 for missing/bad auth, 403 for bad Host/Origin. Shutdown exits the
owned server gracefully; other services and tasks remain untouched.

## 8. OAuth PKCE

Automated end-to-end checks with real local HTTP clients:

```sh
go test ./internal/auth -run 'TestOAuth' -v
go test ./integration -run TestBuiltOAuthHTTP -v
"$BIN" up --oauth --roots "$LAB/work" --state-dir "$LAB/oauth-local" --port 8766
```

In another bash terminal:

```sh
curl --fail http://127.0.0.1:8766/.well-known/oauth-authorization-server
curl --fail http://127.0.0.1:8766/.well-known/oauth-protected-resource/mcp
```

Expected: S256, authorization_code/refresh_token, registration/revocation and
resource metadata; no secrets. The tests assert wrong PKCE failure, redirect
validation, single-use codes, expiry, refresh replay revocation and revoked
MCP rejection. For human consent use the web-connector steps below: approve
only the matching request in the terminal using its two-minute code. A copied
form without the browser cookie/CSRF or a reused/expired code must fail. Stop
local OAuth with Ctrl-C; no persistent service remains.

## 9. Cloudflare tunnel (explicit user action only)

This exposes an authenticated endpoint to the Internet. Skip unless deliberately
choosing that exposure and cloudflared is already installed. It was not run by
automated tests. Use a fresh state directory per launch:

```sh
"$BIN" up --oauth --tunnel cloudflared --probe --roots "$LAB/work" \
  --state-dir "$LAB/probe-tunnel-1" --idle-timeout 10m
```

Expected: HTTPS `https://...trycloudflare.com/mcp`, no token in the URL,
mode readonly. An unauthenticated MCP request is 401; metadata is discoverable.
Use the printed URL for steps 10 and 11. On Ctrl-C only the owned tunnel stops.
Quick Tunnel URLs change, requiring a new connector/reconnection and fresh OAuth
state. `go test ./internal/tunnel -v` tests orchestration using a fake executable
without external network access. Do not kill cloudflared by process name.

## 10. Claude web connection (primary web target)

With the explicitly launched probe from step 9, visit Claude web:
Customize > Connectors > Add custom connector, enter the printed `/mcp` URL,
choose OAuth sign-in and **Register automatically** when offered. Client ID
metadata document registration is not supported in this build. Enter the
request-specific consent code from the local terminal only in the matching
browser form. Review the client, callback, and scope first.

Enable the connector in a new conversation. Ask: “Use probe_read.” Then ask:
“Use search to find hello.txt, and fetch hello.txt.” Finally: “Call probe_write,
the harmless dummy compatibility tool.” Record discovery, read result,
confirmation/blocking and account plan. For a real user-mode test later, start a
fresh explicit tunnel with `--mode user` and only the isolated fixture root,
then attempt a harmless fs_write. This real-account check was not run.

## 11. ChatGPT probe (best effort; do not block other work)

Use the same minimal probe URL, not a server with actual write/exec tools.
In ChatGPT web enable Developer mode if available, create a custom MCP app /
connector in Settings > Apps (labels may differ), enter the `/mcp` URL, and
choose OAuth. Approve the matching local consent request as in step 10. Add it
to a fresh conversation. Ask for each of `probe_read`, `search`, `fetch` and
`probe_write` explicitly. Do not send the local consent code to ChatGPT.

Record this table, including screenshots only if chosen by the user:

| Observation | Actual result |
| --- | --- |
| Date, plan, workspace type, browser | NOT TESTED; review date 2026-11-11 |
| Connector can be created | NOT TESTED |
| tools/list appears; exactly four probe tools | NOT TESTED |
| probe_read runs without a prompt, with a prompt, or blocked | NOT TESTED |
| search/fetch discovery and actual calls | NOT TESTED |
| probe_write asks confirmation, runs, or is blocked | NOT TESTED |
| OAuth registration/callback compatibility | NOT TESTED |

The local SDK tests prove that the probe works on this server; they do not prove
ChatGPT UI/client behavior. Aliases retain filesystem semantics rather than the
full deep-research search/fetch schemas. Record schema-related failures as
compatibility limits. If this plan blocks writes, retain readonly use and
continue testing Claude/Codex separately.

## 12. Current ChatGPT plan and write permissions

Check your actual subscription and workspace policy in ChatGPT. Review the
[official current connector guidance](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).
Use the dummy write result from step 11 as the account-specific probe. Record
whether the tool is visible, disabled, gated by confirmation, or successfully
called. Do not infer Plus write access from documentation or a different plan.
This run has no verified account/plan result; any restriction is a client
compatibility limitation, not automatically a server defect.

## 13. Sudo and dangerous safety tests

```sh
"$BIN" config check --mode dangerous
"$BIN" up --mode sudo --roots "$LAB/work" --state-dir "$LAB/state"
"$BIN" up --mode dangerous --ack-dangerous --roots "$LAB/work" --state-dir "$LAB/state"
go test ./internal/policy ./internal/execrun -run 'TestFakeSudo|TestPolicy|TestSudoersPreview' -v
"$BIN" sudoers preview --sudo-commands /usr/bin/id
```

Expected: missing dangerous opt-in rejected; both privileged HTTP modes rejected
before listening; fake sudo gets literal `-n --` argv; preview is parsed by
`visudo -cf` and printed, never installed. Do not run sudo_exec or privileged
tasks during development testing. Do not open a local dangerous server against
home or `/` as a test. Execution-mode validation can be tested with the pure
policy tests and temporary-root runner, without unrestricted filesystem access.

## 14. Audit and redaction

```sh
python3 - "$LAB/state/audit/audit.jsonl" <<'PY'
import json,sys
for line in open(sys.argv[1]):
    v=json.loads(line)
    assert not ({'argv','content','password','token','environment','authorization'} & v.keys())
    print({k:v.get(k) for k in ('operation','mode','allowed','phase','task_id')})
PY
go test ./internal/audit -v
```

Expected: intent/result and task completion metadata; no contents, argv, env,
Authorization or tokens. Rotation test produces archives in temporary storage.
Task logs/specifications can contain command output/original argv and are
sensitive operational data; do not put credentials into command arguments.

## 15. Idle shutdown

```sh
"$BIN" up --roots "$LAB/work" --state-dir "$LAB/state" \
  --port 8765 --idle-timeout 2s &
HTTP_PID=$!
wait "$HTTP_PID"
"$BIN" status --state-dir "$LAB/state"
go test ./internal/transport -run TestIdleDoesNotInterruptActive -v
```

Expected: server exits after roughly two seconds of no authenticated operation;
status reports no running record. An active operation prevents idle exit; after
completion a full inactivity interval is allowed. Health polling does not keep
the server alive. SDK test also checks actual binary idle exit.

## 16. Disconnect, recovery and cleanup

```sh
go test ./integration -run 'TestDurableTasks|TestTaskSurvivesServerCrash|TestHTTPProbeBinary|TestHTTPIdleKeepsActualRequestAlive|TestBuiltOAuthHTTP' -v
"$BIN" tasks --state-dir "$LAB/state"
```

Expected: disconnect/restart does not kill tasks; normal final status survives
unit collection; OAuth credentials survive a same-issuer restart; no repeated
completion after acknowledgment. A killed worker/reboot is reported lost, not
success. No raw stale-PID signals are attempted. Review and stop any tasks that
you started, close any deliberate tunnel, and only then remove this test lab:

```sh
# Run tasks stop ID for each still-running task you personally started.
# Stop all test HTTP/tunnel foreground commands with Ctrl-C or matching down.
# Confirm no owned test workload remains before deleting its metadata.
# rm -rf -- "$LAB"  # Optional, only after the preceding checks.
unset BIN LAB XDG_CONFIG_HOME BRIDGE_DEV_CONFIG
```
