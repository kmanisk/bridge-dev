# BridgeDev

**Connect ChatGPT Web and AI agents to your computer's files, terminal, Git projects and MCP tools.**

BridgeDev is a self-hosted MCP gateway for inspecting and editing files, executing commands, managing skills and connecting other MCP providers—using permissions you choose.

[![Policy tests](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml)
[![Linux, Windows, macOS](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Features

- **Workspace tools:** Browse, search and edit files, run terminal commands, and manage Git projects.
- **One MCP endpoint:** Connect ChatGPT, Codex, Claude and compatible clients to your machine.
- **Extensions:** Discover and review MCP servers, `SKILL.md` skills and instructions from GitHub, URLs and local folders.
- **Admin UI:** Inspect integrations, permissions and enabled tools.
- **Two modes:** Read & Write for normal development; Full System (sudo) until you switch it off on managed Linux.

## Install and try

Requires **Node.js 24**, **pnpm 12**, and Git. The portable trial needs no root privileges.

**Linux / macOS**

```sh
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run try:local -- --show-secrets
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/kmanisk/bridge-dev.git
Set-Location bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run try:local -- --show-secrets
```

The temporary trial prints a local MCP URL, an Admin UI address and separate credentials. Open the Admin UI and use the printed admin token. Press **Ctrl+C** or enter `quit` to stop and clean up. Keep all tokens private.

**One-command npm installation is [planned in issue #2](https://github.com/kmanisk/bridge-dev/issues/2)**, not published yet. Do not assume `npx bridge-dev@latest setup` is currently available.

## Choose an access mode

The two user-facing modes for a **managed Linux host** are:

| Mode | Access | Command |
| --- | --- | --- |
| **Read & Write** | Normal file, Git and shell operations within approved workspaces; no unrestricted sudo | `bridge-dev mode read-write` |
| **Full System (sudo)** | Unrestricted host-root commands until switched off | `bridge-dev mode sudo` |

Full System asks in **your own local terminal**:

```text
Enable Full System (sudo)? [Y/n]:
```

- Press **Enter** (default Yes) or type **y** to activate; type **n** to decline.
- Full System stays active until manually disabled, including across reboots. Optional timed mode: `bridge-dev mode sudo --duration 60` (1–120 minutes).
- Run `bridge-dev mode sudo --off` to revoke it and return to Read & Write.
- The host controller must first be installed by an independent root operator. See [installation and setup](docs/HOST_CONTROLLER.md).
- If authorization is damaged or missing, an internal **STRICT safety lock** prevents writes. It is not another user-selectable mode.

The gateway remains under its restricted service account; authorized root commands execute through its host controller. Full System permits unrestricted host changes until switched off; revoking access does not reverse earlier commands.

On Windows, macOS and experimental Android/Termux, portable BridgeDev retains the permissions of the OS account running it; Linux-specific host-sudo mode is not available. [Platform support](docs/PLATFORM_SUPPORT.md).

## Connect ChatGPT Web

MCP endpoint for local clients:

```text
http://127.0.0.1:3000/mcp
Authorization: Bearer <MCP_TOKEN>
```

Clients without custom-header support can use `http://127.0.0.1:3000/mcp/<MCP_TOKEN>`. Use the port actually printed at startup.

**ChatGPT Web cannot access your localhost directly.** Configure a separate HTTPS route to the *authenticated MCP endpoint only*; keep the Admin UI private. A new chat or connector refresh may be required after tool updates. For managed commands first call `system_context` and, when MCP sessions change, supply its short-lived `context_token` to the command tool. The context token does not authorize sudo. [MCP security details](docs/POLICY_GATEWAY.md).

## MCP servers and skills

Providers and skills are discovered, **reviewed and enabled separately**. Importing content does not automatically execute source code or grant permissions.

```sh
bridge-dev mcp add https://github.com/owner/example-provider
bridge-dev skills add https://github.com/owner/example-skills
bridge-dev mcp list
bridge-dev skills list
```

Supported formats include selected public GitHub/GitLab, HTTP(S), local files, archives and limited npm/PyPI provider artifacts. General dependency installation, private/SSH sources and community registries still have limitations. [Source formats](docs/SOURCES.md) · [Extension management](docs/EXTENSIONS.md).

## Documentation and security

Portable mode enforces workspace rules at the application layer; **it is not an OS sandbox**. Optional managed Linux deployment adds a restricted UID, signed operator approvals and protected audit logging.

[Local trial](docs/LOCAL_TRIAL.md) · [Linux controller](docs/HOST_CONTROLLER.md) · [Production deployment](docs/DEPLOYMENT.md) · [Security](docs/POLICY_GATEWAY.md) · [Platform matrix](docs/PLATFORM_SUPPORT.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

## License

[MIT](LICENSE). Derived from [chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder) by hoangcoderr; upstream attribution is retained. The historical Go prototype is preserved in `archive/go-prototype`.
