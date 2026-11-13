# BridgeDev

**Run an MCP development gateway on your own device.** Connect ChatGPT, Codex, Claude Code or another MCP client to a scoped project workspace, then add skills, Markdown instructions and upstream MCP servers only when you want them.

[Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [Extensions](#extensions) · [Platform support](#platform-support) · [Security](#security) · [Documentation](#documentation)

[![Policy tests](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml)
[![Portable platforms](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## What it does

- **Work on your files:** Read, search, edit, patch, Git, run builds/tests and inspect process output.
- **Start portable:** Localhost-only workspace scope by default; no systemd, sudo or chezmoi dependency.
- **Add your context:** Project \`AGENTS.md\` / \`CLAUDE.md\`, \`SKILL.md\` directories, extra Markdown, and HTTPS reference links.
- **Connect other MCPs:** Configure HTTP or stdio providers separately, with explicit enablement and tool allowlists.
- **Go hardened on Linux:** Optional restricted service account, operator-signed approvals, audit-chain anchor and temporary administration lease.

## Platform support

| Host | Portable source runtime | Hardened host integration |
| --- | --- | --- |
| Linux (Arch/CachyOS, Debian/Ubuntu, Fedora, etc.) | Supported by portable CI | Operator-installed systemd profile |
| Windows 10/11 | CI-tested Node.js build/portable logic | Linux-specific sandbox/broker unavailable |
| macOS | CI-tested Node.js build/portable logic | Linux-specific sandbox/broker unavailable |
| Android / Termux | **Experimental**, manual source build | Not supported |

The same portable Node.js core is intended for all hosts; only Linux has the existing restricted-UID and systemd security model. Windows/macOS/Android are **not** equivalent to the hardened Linux deployment. See [platform details](docs/PLATFORM_SUPPORT.md).

## Install

**Requirements:** Node.js 20+ (CI uses 24), pnpm, Git. Choose your host:

- **Linux:** Install Node.js, pnpm and Git using your distribution's supported package manager or version manager. [Linux notes](docs/PLATFORM_SUPPORT.md#linux)
- **Windows:** Install Node.js, pnpm and Git, then use PowerShell.
- **macOS:** Install Node.js, pnpm and Git (Homebrew or official installers).
- **Android:** Use Termux with Node.js/Git, then follow the [experimental guide](docs/PLATFORM_SUPPORT.md#android--termux).

In any shell with the prerequisites available:

~~~sh
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
~~~

## Quick start

1. Copy \`.env.example\` to \`.env\` (\`cp .env.example .env\` on Linux/macOS/Termux, \`Copy-Item .env.example .env\` on Windows).
2. Generate a token with \`node dist/cli.js login --generate\`, and privately place it in \`.env\` as \`MCP_TOKEN\`. Set \`WORKSPACE_PATH\` to **your own project** (default \`.\` only for trying the server).
3. Start in the foreground: \`pnpm start\`. No service or tunnel is installed automatically.
4. Use \`node dist/cli.js connect\` for a redacted endpoint. Configure your MCP client with \`http://127.0.0.1:3000/mcp/<MCP_TOKEN>\` locally. **The token is in the URL path**, not an Authorization header.

For remote clients, use an operator-controlled HTTPS route and do not publish the admin interface. Keep credentials out of logs and screenshots. [Connection troubleshooting](docs/TROUBLESHOOTING.md).

## Commands

From the cloned repository, use \`node dist/cli.js\` (or \`bridge-dev\` after installing the CLI bin):

| Command | Purpose |
| --- | --- |
| \`bridge-dev\` / \`status\` | Workspace, runtime, connection and security status |
| \`bridge-dev setup\` | Check detected platform, workspace and optional modules |
| \`bridge-dev login --generate\` | Generate a new token (does not write it automatically) |
| \`bridge-dev connect\` | Show MCP connection instructions with token redacted |
| \`bridge-dev serve\` | Run a foreground gateway; Ctrl-C stops it |
| \`bridge-dev doctor\` | Inspect health, report unverifiable security checks explicitly |
| \`bridge-dev help\` | Show available commands |

\`mode\`, \`project map\`, \`stop\` and \`restart\` are **operator-managed Linux installation** commands, not universal portable functions. They are unavailable or require separate authorization on other hosts.

## Extensions

No plugin installation or account connection is required to start. Each project can contain:

~~~text
my-project/
  AGENTS.md
  .bridge-dev/
    extensions.json        # optional, safe Markdown references + skill roots
    instructions.md
    skills/
      code-review/SKILL.md
    mcp.json                # optional upstream MCP config (empty by default)
~~~

Skills are also discovered from \`.agents/skills\` and \`.claude/skills\`. Use [examples/extensions.example.json](examples/extensions.example.json) as a template. Local Markdown instructions stay within the workspace; external HTTPS links are listed as references **without fetching or executing them**.

[Add skills and Markdown](docs/EXTENSIONS.md) · [Add MCP integrations](docs/MCP_INTEGRATIONS.md)

## Security

**Portable:** Localhost-only listener, approved workspace writes, secret/path checks, command policy and an application audit chain. Privileged operations cannot silently become root. This is **not an OS sandbox**; run it with an account that has only the access you intend.

**Managed Linux:** Restricted service identity, root-owned policy and key material, append-only anchored ledger, independently approved privileged operations. Modes: **STRICT**, **STANDARD** (default), **YOLO** (temporary signed lease only). These protections require independent operator provisioning and are not enabled by cloning the repository.

[Security architecture](docs/POLICY_GATEWAY.md) · [Managed Linux deployment](docs/SYSTEMD_DEPLOYMENT.md)

## Documentation

[Platforms](docs/PLATFORM_SUPPORT.md) · [Extensions and skills](docs/EXTENSIONS.md) · [MCP providers](docs/MCP_INTEGRATIONS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Contributing](AGENTS.md)

Licensed under [MIT](LICENSE). The TypeScript project derives from the MIT-licensed [chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder) by hoangcoderr; original attribution is preserved. The earlier BridgeDev Go prototype is kept on \`archive/go-prototype\`.
