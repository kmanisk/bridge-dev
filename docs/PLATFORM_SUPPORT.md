# Platform support and verification

## Verified coverage

The expanded matrix passed at `4f6cf9e` on 2026-11-13:

- [Native Linux, Windows, macOS and Linux source fixtures](https://github.com/kmanisk/bridge-dev/actions/runs/43447654179).
- [Debian, Fedora and Arch containers](https://github.com/kmanisk/bridge-dev/actions/runs/43447654353).
- [Managed policy and inventory regressions](https://github.com/kmanisk/bridge-dev/actions/runs/43447654408).

Final-head runs are available through the README workflow badges and the final
completion report. A prior green run is evidence only for its SHA.

| Platform | Verified | Guarantees / restrictions |
| --- | --- | --- |
| CachyOS/Linux host | Full isolated aggregate, policy, sources, CLI, HTTP scenarios and browser admin flow | Existing managed deployment was not changed or redeployed |
| Ubuntu native CI | Startup/auth, CLI, provider routing/crash cleanup, scoped content, security and HTTP management | Unprivileged fixture tests; privileged host deployment is separate |
| Debian container | Portable core and extension/security scenarios | Disposable container uses `--init` to reap orphan descendants |
| Fedora container | Same, including distro Node 22 | Explicit stream cancellation avoids the older Node adapter race |
| Arch container | Same, with current distro runtime | Packages installed only in the disposable CI container |
| Windows native CI | Node 24 startup/auth, CLI, two provider transports, crash/descendant cleanup, content/security and HTTP management | PowerShell 7 cleanup path verified; no Job Object/OS sandbox equivalence claimed |
| macOS native CI | Same portable and extension scenarios | Canonical `/var` aliases handled; no hardened launchd/sandbox deployment claimed |
| Android/Termux | Experimental; no hardware run | No Android CI, root broker, background lifetime or device compatibility claim |

Actual ChatGPT/Codex/Claude account acceptance was not run. Independent MCP SDK
clients exercise the HTTP gateway and both HTTP/stdio providers. Remote access
requires an operator-controlled HTTPS route; no tunnel or deployment is automatic.

## Portable runtime

Recommended setup: Node.js 24, pnpm 12 and Git. Fedora's packaged Node 22 and Arch's
runtime are exercised by distribution CI. Optional Python wheel installation needs
Python 3 with venv/pip. Optional browser QA uses an existing Chromium-compatible
binary. No new Node runtime dependency was added by this work.

Portable mode is selected without `POLICYGATE_POLICY_FILE`. It binds only to
loopback, scopes workspace operations and protects gateway-owned state. It does not
scan production services, read workstation-wide context by default or grant root.
Use `BRIDGEDEV_STATE_DIR` for an explicit state location. No persistent service is
installed or enabled. Portable strict/standard changes and stop/restart use the
independently authenticated operator API; restart serves again in the foreground.

The process still has the OS account's access. Application checks are not a kernel
sandbox; use a restricted account/container for untrusted execution. POSIX process
groups and Windows process snapshots provide cleanup rather than malicious-process
containment. Windows file modes do not establish POSIX-style ACL guarantees.

## Windows

Install Node.js, pnpm and Git, then use PowerShell and the README clone/build steps.
The CLI loads `.env`; use `Copy-Item .env.example .env` and set two private independent
tokens and the workspace. No systemd, Linux mounts, sudo or package manager is assumed.

Provider env grants are explicit. `SYSTEMROOT`/`WINDIR` are visible platform
requirements; other variables libuv would automatically inherit are blanked.
Cleanup uses taskkill for live trees and a bounded native Toolhelp snapshot helper
for crashed roots. PowerShell 7 is preferred. The legacy Windows PowerShell fallback
is retained but has not passed the expanded cleanup scenario and must not be treated
as equivalent verification. The helper changes no persistent execution policy.

## Managed Linux

Managed mode requires an explicit independently owned policy; a missing or invalid
policy never silently falls back to portable. Restricted UID, root-owned approvals,
append-only audit/anchor and temporary YOLO require separate provisioning. Existing
legacy names/paths remain compatible. [Deployment](SYSTEMD_DEPLOYMENT.md) and
[policy](POLICY_GATEWAY.md) describe those additional boundaries.

This task did not install services, modify live code/configuration, rotate
credentials, touch Funnel/Tailscale or change VMs/laptop settings. Source pushes do
not constitute deployment or privileged-host acceptance.

## Android / Termux

A Termux source build can be attempted using its Node.js/Git packages, followed by
pnpm install/build and a foreground loopback server. It remains experimental until
actually tested on a device. PRoot is not kernel-enforced isolation. Do not assume
Linux systemd helpers or signed privileged host operations are available.
