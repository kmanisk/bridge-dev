# BridgeDev

**One MCP gateway for development tools, reviewed integrations, and reusable skills.**

BridgeDev connects MCP clients to workspace-aware filesystem, Git and command tools. Add compatible HTTP/stdio MCP providers, discover skills and Markdown instructions, and manage everything through a CLI or local Admin UI.

[![Security & policy](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml)
[![Linux, Windows, macOS](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml)
[![Linux distributions](https://github.com/kmanisk/bridge-dev/actions/workflows/linux-distributions.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/linux-distributions.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

| Feature | Capability |
| --- | --- |
| **Single MCP endpoint** | Native development tools and approved, namespaced external MCP tools |
| **MCP manager** | Discover, review, register, test, enable, disable and update compatible HTTP/stdio providers |
| **Skills and Markdown** | Import selected `SKILL.md` files, instructions and extension packs from supported sources |
| **Admin UI and CLI** | Review proposals, manage scope and permissions, and inspect runtime state |
| **Portable mode** | Localhost foreground operation without root or a permanent service |
| **Managed Linux mode** | Optional restricted account, signed operator approvals and protected audit logging |

No external MCP servers are required to start. New providers and imported content are disabled until explicitly reviewed. Skills are instructions, not executable permissions.

## Install and try it now

Requires **Node.js 24**, **pnpm 12** and **Git**. Python/venv/pip is optional for compatible Python-wheel providers.

**Linux / macOS — terminal**

~~~sh
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run try:local -- --show-secrets
~~~

**Windows — PowerShell**

~~~powershell
git clone https://github.com/kmanisk/bridge-dev.git
Set-Location bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run try:local -- --show-secrets
~~~

The trial automatically selects free **localhost** ports, generates separate MCP/admin credentials and creates a disposable workspace. Open the printed **Admin UI** address in your browser and sign in with the printed admin token. Keep the printed private MCP URL and tokens out of screenshots, logs and Git commits.

Type `quit` or press **Ctrl+C** to stop. The trial cleans up its temporary project and credentials; it does not install a service, modify production, or start a tunnel.

For an automated smoke test, run `pnpm run test:trial`.

[Local trial guide](docs/LOCAL_TRIAL.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

### One-command installation — planned, not yet available

The intended future experience is a **single `npx` setup command**, with prebuilt runtime assets, generated private credentials, a first-run wizard, and no manual Git clone or TypeScript build. **No verified BridgeDev npm installer has been published yet.** Do not treat `npx bridge-dev@latest setup` as an available command.

**Tracking:** [#2 — One-command npm/npx installer for Linux, Windows, macOS and experimental Termux](https://github.com/kmanisk/bridge-dev/issues/2). The README will switch to the verified installer only after package publication and clean-install tests.

## Supported platforms

| Platform | Current evidence and limitations |
| --- | --- |
| **Linux (Arch/CachyOS, Debian, Fedora, Ubuntu)** | Native Linux and distro-container tests; managed systemd integration is separate |
| **Windows** | Native CI verifies portable startup, authentication and extension/MCP scenarios; no Linux-root equivalence |
| **macOS** | Native CI verifies portable gateway and extension scenarios; no hardened launchd claim |
| **Android / Termux** | **Experimental; no hardware acceptance yet.** No assumed systemd, sudo, or OS sandbox |

The same eventual `npx` interface is a goal, not a guarantee of identical platform capabilities. [Coverage details](docs/PLATFORM_SUPPORT.md).

## Configure a persistent foreground instance

For a workspace you want to keep instead of the disposable trial:

1. Copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`).
2. Run `node dist/cli.js login --generate` twice; set **different** generated values for `MCP_TOKEN` and `ADMIN_TOKEN` in the private `.env`.
3. Set `WORKSPACE_PATH` to your intended project directory.
4. Run `node dist/cli.js serve`.
5. Open `http://127.0.0.1:3001/ui/` and authenticate using `ADMIN_TOKEN` (or the configured Admin port).

This starts in the foreground; no systemd service or remote tunnel is created automatically. Keep the Admin port bound to loopback. [Managed Linux deployment](docs/SYSTEMD_DEPLOYMENT.md) requires separately reviewed operator actions.

## Connect an MCP client

The gateway accepts either a Bearer header on the MCP path or a compatible token-bearing URL:

~~~text
http://127.0.0.1:3000/mcp
Authorization: Bearer <MCP_TOKEN>

http://127.0.0.1:3000/mcp/<MCP_TOKEN>
~~~

Use the **actual trial port** or your selected production port. `node dist/cli.js connect` prints a redacted connection example.

**ChatGPT Web cannot reach a local-only address.** Remote clients need an independently configured HTTPS route to the authenticated MCP port. Never forward the Admin UI. Tool-list caching may require refreshing the connector or starting a new chat when providers change.

## Add MCP providers and skills

From a checkout, replace `bridge-dev` below with `node dist/cli.js`.

**Add a compatible MCP provider**

~~~sh
bridge-dev mcp add https://github.com/owner/compatible-provider
# Review the resolved source, exact requirements and proposal ID.
bridge-dev approve <proposal-id>
bridge-dev mcp test <provider-name>
bridge-dev mcp enable <provider-name> --tools <tool-name> --permission R
bridge-dev approve <enable-proposal-id>
~~~

The repository must include a supported MCP definition. Discovery does not execute README install commands, install arbitrary dependencies or grant tool permissions. Only mark a tool `R` after confirming it is read-only.

**Add a skill**

~~~sh
bridge-dev add https://github.com/owner/skills
# Inspect candidates, then select just the desired skill.
bridge-dev add https://github.com/owner/skills --select skill:code-review
bridge-dev approve <proposal-id>
bridge-dev skills enable code-review
bridge-dev approve <enable-proposal-id>
~~~

Source discovery supports public GitHub/GitLab and HTTPS Git repositories, raw Markdown/JSON and `SKILL.md` URLs, reviewed archives, local sources, and limited npm/PyPI provider artifacts. **Installing npm-hosted MCP providers is not the same as publishing BridgeDev itself on npm.** SSH/private-source adapters, general package dependency resolution and community registry discovery remain unsupported. [Source formats and limits](docs/SOURCES.md).

**CLI command families**

~~~text
bridge-dev status | setup | login | connect | doctor | serve | help
bridge-dev mcp list|info|add|remove|enable|disable|update|test|tools|status
bridge-dev skills list|info|add|remove|enable|disable|update|validate
bridge-dev instructions list|info|add|remove|enable|disable|update
bridge-dev pack list|info|add|update|remove
~~~

Provider registration, exposure, execution permissions and operator approvals are separate. MCP clients can submit proposals but cannot approve or sign their own installation. [Extensions and CLI](docs/EXTENSIONS.md) · [Provider setup](docs/MCP_INTEGRATIONS.md).

## Security

- **Portable mode** limits access at the application level and listens on localhost; it **does not** provide a kernel-enforced sandbox. The process retains its OS-account privileges.
- **Managed Linux** is a separately provisioned restricted service with root-owned policy, protected ledger, signed approvals, and explicitly authorized, time-limited privileged modes.
- **External providers** start disabled. Approval of an import never means arbitrary code from its source may execute automatically.
- Source downloads, redirects and archives have bounded checks against SSRF, traversal and unsafe entries.

[Policy design](docs/POLICY_GATEWAY.md) · [Platform limits](docs/PLATFORM_SUPPORT.md)

## Documentation

[Local trial](docs/LOCAL_TRIAL.md) · [Platform support](docs/PLATFORM_SUPPORT.md) · [Sources](docs/SOURCES.md) · [Extensions](docs/EXTENSIONS.md) · [MCP integrations](docs/MCP_INTEGRATIONS.md) · [Managed deployment](docs/SYSTEMD_DEPLOYMENT.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Completion audit](docs/COMPLETION_AUDIT.md)

## License and attribution

[MIT](LICENSE). Derived from [chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder) by hoangcoderr; original attribution is retained. The historical Go prototype is preserved on `archive/go-prototype`.
