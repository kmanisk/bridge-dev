# Final integration handoff

Continue in /home/onyx/Projects/bridge-dev. M8-M15 are retained. Final sprint A
commit 54ae0e2 fixes consent browser Origins; Sprint C adds wizard/prompt/idle
reliability. Read TEST_REPORT.md and REQUIREMENTS.md for current evidence rather
than treating historical M15 tables as the latest state.

On 2026-11-11, GitHub confirmed kmanisk/bridge-dev is PUBLIC, and the user
explicitly authorized a verified fix pushed to main for local git pull. This
supersedes the previous private-only publication restriction. Do not change
repository visibility, push unrelated projects, enable a permanent service,
run real sudo/dangerous tests, or alter unrelated workstation/client configuration.
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

## 2026-11-11 OAuth browser consent recovery

The approved terminal ceremony had two browser completion defects:
the consent document's CSP `form-action 'self'` blocked the registered
cross-origin OAuth callback after the POST's HTTP 303, and duplicate terminal
polls returned `invalid_request` after the pending request was deleted.
Both terminal and local consent documents now allow only the validated
registered callback origin in `form-action`; Host/Origin, CSRF, SameSite
cookie, exact redirect registration, state/iss, PKCE and one-use codes remain.
Completed same-browser polls can replay the original 303 for one minute
without generating a second code. Safe reason labels distinguish rejection
conditions without logging cookies, states, codes or redirect URLs.

Browser integration coverage uses a real headless Chromium process, cross-site
navigation, callback receipt, PKCE token exchange and replay rejection. The
targeted auth race tests, Go vet/full Go suite, Staticcheck and gofmt passed
in isolated GitHub Actions run 43058478581. An unrelated instantaneous fake
tunnel exit test was corrected to accept both valid race outcomes; no
production tunnel logic was modified. The temporary CI workflow exists only
on `fix/oauth-consent-replay`, not on `main`.

Desktop Commander reported its monthly usage cap, so the live machine's
running server/tunnel, startup state, and public MCP URL were not inspected
or restarted. The user should pull main, run `make build` and follow the
existing Bridge-owned start/stop lifecycle after checking active tasks.
No actual ChatGPT OAuth callback, token exchange or MCP read was independently
observed from the live connector; that acceptance check remains manual.
