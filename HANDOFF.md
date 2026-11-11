# Final integration handoff

Continue in /home/onyx/Projects/bridge-dev. M8-M15 are retained. Final sprint A
commit 54ae0e2 fixes consent browser Origins; Sprint C adds wizard/prompt/idle
reliability. Read TEST_REPORT.md and REQUIREMENTS.md for current evidence rather
than treating historical M15 tables as the latest state.

User now authorizes local verified commits and creation/push only to PRIVATE
kmanisk/bridge-dev, plus one controlled readonly public Quick Tunnel. Never change
visibility to public, push unrelated repositories, enable a permanent service, run
real sudo/dangerous tests or alter unrelated workstation/client configuration.
The project module/name remain github.com/kmanisk/bridge-dev and bridge-dev.

Binary: /home/onyx/Projects/bridge-dev/bin/bridge-dev. Start bridge-dev connect;
stop bridge-dev down. A dedicated bridge-connect tmux session may already own the
readonly server. Inspect status/process identity before replacing it. Keep existing
stdio clients and background tasks intact. Saved TOML/preferences and prior OAuth
registrations were preserved; private origin/config backups are in XDG state.

The old no-referrer consent document made browser form POST Origin:null. Retain
same-origin document policy and strict unsafe-Origin checks, safe GET navigation,
canonical Host, exact DCR redirects, PKCE, CSRF/cookie, state/iss and terminal human
consent. Denied/expired validated requests redirect access_denied with state/iss.
Never approve real OAuth on behalf of the user. Discovery self-probes must not
extend idle lifetime. Terminal event presentation is bounded while prompts run;
durable auditing continues. The optional dashboard is unimplemented/deferred.

Current public hostname is ephemeral: obtain it from bridge-dev status, not old
reports. ChatGPT custom connector creation/OAuth initiation was observed by the
user, but final callback/read is pending human reconnect/approval. Real Claude web
is untested. Actual active local Codex MCP reads passed with a harmless new fixture;
actual built SDK subprocess tests cover stdio/HTTP/OAuth/tasks. Native macOS/ARM64,
provider write support, named tunnels and actual sudo contexts remain manual.

Tests use temporary roots/XDG, PATH fake sudo/cloudflared/client binaries and
loopback proxies. No public tunnel or actual privilege operation belongs in the
automated suite. Keep unknown crash outcomes unknown; do not rerun dispatched
operations under a new key. See pinned Desktop Commander comparison for adopted
pagination/search/install/event lessons; no Node dependency/source was imported.

Final gate and private GitHub publication results follow TEST_REPORT.md. Audit the
actual gh remote visibility/HEAD before claiming a push passed. Ignored build,
coverage and test-output artifacts remain local; no secrets belong in commits.

Live recovery additionally found daemonized clipboard output holding exec's copier
pipes open. Preserve the direct-null-output/WaitDelay fix and fake-fork regression.
The verified old HTTP process required diagnostic SIGQUIT after graceful down had
stopped the owned tunnel; no tasks or other stdio processes were terminated. The
private repository exists and initial verified source cb564c6 was pushed. Check the
final TEST_REPORT/publication receipt and remote HEAD for the final follow-up.
