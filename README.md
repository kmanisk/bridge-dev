# BridgeDev

**Your computer. One MCP gateway. Your rules.**

A fast, local-first bridge between AI assistants and the tools on your machine.
BridgeDev connects ChatGPT, Codex, Claude, and other MCP clients to approved
files, terminals, Git repositories, skills, and MCP servers — without requiring
a cloud-hosted agent or an always-on update watcher.

[![Policy tests](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml)
[![Cross-platform](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml)
[![Linux distributions](https://github.com/kmanisk/bridge-dev/actions/workflows/linux-distributions.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/linux-distributions.yml)
[![MIT](https://img.shields.io/badge/license-MIT-555.svg)](LICENSE)

**Local by default · Portable core · Operator-controlled access · On-demand extensions**

## Install

Requires **Node.js 22+ and npm**. No Git checkout, global TypeScript or pnpm
installation is required. The standard portable install needs no administrator
permissions, background service, or host-root controller.

**Linux / macOS / Termux**

```sh
curl -fsSL \
  https://raw.githubusercontent.com/kmanisk/bridge-dev/main/install.sh \
  | sh
```

**Windows PowerShell**

```powershell
irm 'https://raw.githubusercontent.com/kmanisk/bridge-dev/main/install.ps1' |
  iex
```

These one-command installers download the GitHub source, build it under your
own account, and keep private configuration and tokens separate from the app.
Inspect the [installer](install.sh) or [PowerShell version](install.ps1) before
running remote code. Termux hardware support is still **experimental**.

## Open BridgeDev

### Managed Linux — one command per action

If you have already installed the optional user service:

```sh
bridge-dev start
bridge-dev dashboard
```

**Start** uses the installed systemd user service instead of occupying your
terminal. **Dashboard** opens the local Admin UI using a one-use pairing link:
no token copying and no second terminal for this workflow.

If you have not installed the optional user service, set it up once through
the [reviewed Linux service procedure](docs/PERSISTENT_SERVICE.md).
A portable install does **not** silently enable a service or create root access.

### Portable Linux, macOS, Windows, Termux

```sh
bridge-dev start
```

Portable start runs in the **foreground**. It stops with Ctrl+C. While it is
running, use `bridge-dev access` in another **private local terminal** for the
Admin pairing link and MCP URL. This extra terminal is a current portable-mode
limitation, not a requirement for the managed Linux service. On Linux,
`bridge-dev dashboard` can open pairing directly when a gateway is already
running; Windows/macOS should use `bridge-dev access`.

[Installation, paths and platform-specific setup](docs/INSTALL.md)

## Connect an AI assistant

**Local browser:** `bridge-dev dashboard` opens the private Admin UI on
supported Linux installations. Pairing links expire after **60 seconds**;
the signed browser session normally lasts **up to seven days**.

**MCP client:**

1. Run `bridge-dev access` in your own private terminal.
2. Copy its authenticated MCP URL to your compatible client.
3. Confirm the connection using `bridge-dev doctor` or a read-only tool call.

ChatGPT Web cannot call localhost directly. It needs an **explicitly configured
HTTPS endpoint** for the authenticated MCP route. BridgeDev does not expose
that route automatically. Keep the Admin dashboard loopback-only and never
share connection URLs, tokens, pairing links, or screenshots containing them.

[ChatGPT and MCP connection guide](docs/MCP_INTEGRATIONS.md) ·
[Admin pairing/security](docs/ADMIN_AUTH.md)

## Everyday commands

| What you want | Command |
| --- | --- |
| Open the local dashboard (Linux) | `bridge-dev dashboard` |
| Start the gateway | `bridge-dev start` |
| Stop the gateway | `bridge-dev stop` |
| Check health and environment | `bridge-dev doctor` |
| Show runtime and access mode | `bridge-dev status` |
| Get private connection details | `bridge-dev access` |
| Check for a new managed release | `bridge-dev update --check` |
| Update a managed Linux service | `bridge-dev update` |
| Inspect available MCP servers | `bridge-dev mcp list` |
| List enabled/reviewed skills | `bridge-dev skills list` |
| View or authorize workspaces | `bridge-dev workspace list` |
| See all commands | `bridge-dev help` |

CLI output stays brief by default. Use `--verbose` for diagnostics or `--json`
for structured results. Private on-demand CLI events are kept under
`~/.local/state/bridge-dev/private-cli/events.jsonl`; tracked update jobs retain
their full systemd journals. Operator authorization prompts remain visible.

### One-command verified update (managed Linux)

```sh
bridge-dev update
```

A managed update checks the exact GitHub release and CI, stages a verified
artifact, performs a guarded service cutover, checks STANDARD-mode acceptance,
and preserves rollback. If an **existing independently authorized YOLO lease**
is active, the local CLI coordinates the temporary STANDARD transition and
offers a **new local confirmation** before restoring that lease. Failed or
unfinished updates remain STANDARD; root authorization is never silently
created or restored.

No manual `mode standard` / `mode yolo` sequence, `git pull`, credential
rotation, or background update daemon is required. Portable installs use
the [installer update procedure](docs/INSTALL.md#updating) instead.

[Release security and recovery](docs/PERSISTENT_SERVICE.md)

## What it does

- **Computer operations** — read/search files, make targeted edits, execute
  permitted commands, and work with Git repositories.
- **One MCP endpoint** — keep multiple tools and reviewed upstream providers
  behind one authenticated connection.
- **Persistent full-provider access** — review all compatible tools once,
  preserve their approved names across restarts, and keep unreviewed execution
  and incompatible schemas blocked.
- **Discoverable extensions** — browse a catalog, inspect providers and skills,
  and review changes before enabling executable integrations.
- **Local operations dashboard** — see active providers, custom resources,
  tool activity, approvals and audit information without public Admin access.
- **Recoverable work** — tracked jobs, audit receipts, and controlled rollback
  for supported managed deployments.
- **Minimal overhead** — no default updater watcher, unnecessary global
  dependencies, or automatic third-party provider installation.

### MCP providers are not just catalog listings

The Marketplace contains **106 reviewed catalog entries** (metadata, not
installed tools). The separate **Custom** view discovers the current operator's
local skills without publishing host-specific paths in the portable catalog.

For example, [Reverse Engineer Anything (REA)](docs/integrations/REA.md) is
supported as an optional reviewed MCP provider. Its large tool inventory can be
tested and selectively approved without installing new analysis engines.
Schema compatibility does **not** prove that an EXE or APK was decompiled:
real binary analysis still needs the appropriate engine, sample and permissions.
See the [REA verification record](docs/integrations/REA.md) for current counts.

## Security: usable by default, powerful only on purpose

**STANDARD** is the portable/default mode: authorized workspace paths,
ordinary user-level tools, and OS permissions still apply.

**YOLO / Full System** is an **optional managed Linux** feature with a
separately installed host controller and independent **local operator
authorization**. It can grant remote root-command execution until manually
revoked (or for a chosen timed lease). This is high risk, especially if the MCP
endpoint is reachable remotely.

```sh
bridge-dev mode status     # Inspect authorization
bridge-dev mode yolo       # Explicit local confirmation; managed Linux only
bridge-dev mode standard   # Revoke YOLO / return to STANDARD
```

A remote MCP client cannot grant itself root access. A signed lease is not an
OS sandbox and cannot undo arbitrary commands already executed as root.

[Security model](docs/POLICY_GATEWAY.md) ·
[Independent host controller](docs/HOST_CONTROLLER.md)

## Platforms and verification

- **Linux:** portable runtime; Arch, Fedora, Debian/Ubuntu CI; optional
  independently managed service and root controller.
- **Windows:** portable Node/PowerShell runtime covered by native CI. Live
  end-to-end workstation acceptance is a separate step.
- **macOS:** portable runtime covered by native CI. No claim of a hardened
  native service deployment.
- **Android / Termux / Waydroid:** experimental until actual-device testing;
  Linux systemd and root-controller features do not transfer automatically.

CI verifies the tested commit, not every physical computer or connected AI
account. Platform and real-client gaps are tracked in
[platform support](docs/PLATFORM_SUPPORT.md).

## Documentation

[Install](docs/INSTALL.md) ·
[Android/Termux device MCP integration](docs/ANDROID_DEVICE_MCP.md) ·
[Dashboard](docs/DASHBOARD.md) ·
[Extensions](docs/EXTENSIONS.md) ·
[Marketplace](docs/MARKETPLACE.md) ·
[REA integration](docs/integrations/REA.md) ·
[Managed Linux](docs/PERSISTENT_SERVICE.md) ·
[Security](docs/POLICY_GATEWAY.md) ·
[Troubleshooting](docs/TROUBLESHOOTING.md)

## License and attribution

[MIT licensed](LICENSE). BridgeDev builds on earlier work by
[hoangcoderr](https://github.com/hoangcoderr/chatgpt-local-coder).
The original copyright and permission notice are retained in `LICENSE`.
The historical Go prototype is retained in Git history, not in the current source tree.
