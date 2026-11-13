# BridgeDev

A scoped MCP gateway with reviewed MCP providers, skills, Markdown instructions and extension packs. Connect an MCP client to one gateway and manage extensions through the CLI or local admin interface.

[![Policy](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml)
[![Platforms](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml)
[![Linux distributions](https://github.com/kmanisk/bridge-dev/actions/workflows/linux-distributions.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/linux-distributions.yml)

## What it does

- Runs with built-in files, patches, Git and command tools and no optional providers.
- Routes approved HTTP/stdio MCP tools under deterministic provider namespaces.
- Discovers compatible Git repositories, HTTPS files/archives, local content and reviewed package artifacts.
- Stores provenance, versions, hashes and user/project scope; previews changes before operator approval.
- Lets MCP clients inspect extensions and submit requests without approving their own installations.

## Platforms

Native Linux, Windows and macOS startup, authentication, CLI and extension scenarios pass GitHub Actions. Debian, Fedora and Arch container scenarios also pass. Android/Termux is **experimental and unverified on hardware**. Portable mode runs with the OS account's permissions; hardened Linux deployment is separate. [Actual coverage](docs/PLATFORM_SUPPORT.md).

## Installation

Use Node.js 24, pnpm 12 and Git. Python with venv/pip is needed only for compatible wheel installation; Windows process cleanup uses PowerShell.

```sh
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

Run `node dist/cli.js help`. Below, `bridge-dev` means that CLI entrypoint; from this checkout, replace it with `node dist/cli.js`. No service, tunnel or integration is installed automatically.

## Try it locally first (no installation)

After building, run this on Linux, macOS or Windows in your private terminal:

~~~sh
pnpm run try:local -- --show-secrets
~~~

BridgeDev launches a **temporary, loopback-only** gateway on unused ports, creates a disposable project, generates independent MCP/admin tokens and prints its local admin URL. Open that URL, enter the printed admin token, and inspect **MCP providers**, **skills** or **status**. Connect a **local** MCP client using the private MCP URL printed in the terminal.

Type \`quit\` or press Ctrl-C to stop. The trial deletes its temporary workspace and credentials, and never changes your installed production gateway, service, Funnel or Git configuration. This trial is **not an OS sandbox** and must not run untrusted commands. To verify just the trial without opening a browser, run \`pnpm run test:trial\`.

**ChatGPT Web cannot reach your laptop's localhost.** Test with a local MCP client first; use a separately approved HTTPS route for a later remote-client test, without changing an existing production Funnel. [Detailed trial steps](docs/LOCAL_TRIAL.md).

## Quick start

1. Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell).
2. Run `node dist/cli.js login --generate` twice. Privately set **different** generated values for `MCP_TOKEN` and `ADMIN_TOKEN` in `.env`.
3. Set `WORKSPACE_PATH` to your project directory, then run `node dist/cli.js serve`.
4. Open `http://127.0.0.1:3001/ui/`, enter the independent admin token and click Refresh.

CLI and server read the same `.env` in the current directory. Keep it private. The gateway binds to loopback; remote access requires an independently configured HTTPS route. Never publish the admin port.

## Essential commands

```text
bridge-dev status | setup | login | connect | doctor | serve | help
bridge-dev add <source> [--select kind:name,...] [--scope user|project]
bridge-dev approve <exact-proposal-id>
bridge-dev mcp list|search|info|add|remove|enable|disable|update|test|tools|logs|status|import|export
bridge-dev skills list|search|info|add|remove|enable|disable|update|validate|sources
bridge-dev instructions list|info|add|remove|enable|disable|update
bridge-dev pack add|info|list|update|remove
```

Use `--json` for structured output and `--verbose` for full previews/diagnostics. `approve`, portable mode changes and lifecycle stop/restart require the independent admin credential. [Command behavior](docs/EXTENSIONS.md).

## Add your first MCP

```sh
bridge-dev mcp add https://github.com/owner/compatible-provider
# Review the source, resolved version, requirements and proposal ID.
bridge-dev approve <proposal-id>
bridge-dev mcp test <provider-name>
bridge-dev mcp enable <provider-name> --tools <tool-name> --permission R
bridge-dev approve <enable-proposal-id>
```

The repository must contain a compatible MCP definition, such as `bridge-dev.json` or a JSON MCP export. A manifestless repository reports the blocker; README commands are never run. `R` is your assertion of read-only behavior. Imported providers start disabled; registering one does not install its native dependencies. [Provider definitions and permissions](docs/MCP_INTEGRATIONS.md).

## Add a skill from GitHub

```sh
bridge-dev add https://github.com/owner/skills
# Select only the desired candidates shown by discovery.
bridge-dev add https://github.com/owner/skills --select skill:code-review
bridge-dev approve <proposal-id>
bridge-dev skills enable code-review
bridge-dev approve <enable-proposal-id>
```

Raw `SKILL.md` URLs and local directories also work. Skills and instructions are untrusted guidance and never execute embedded scripts. [Sources, packs and scope](docs/EXTENSIONS.md).

## Connect ChatGPT, Codex or another MCP client

Use `/mcp` with `Authorization: Bearer <MCP_TOKEN>`, or the compatible token URL `/mcp/<MCP_TOKEN>` when the client requires URL authentication. `bridge-dev connect` prints a redacted example; `--show-token` reveals it explicitly.

ChatGPT Web needs your operator-controlled public HTTPS route. Codex, Claude and other clients can use the same MCP endpoint. Local independent-client protocol tests pass; real account acceptance is **not claimed**. Clients that cache tools may require a connector refresh and a new chat after provider changes.

## Security and current limits

Default exposure is deny. Operator approvals bind exact proposals and provider changes; MCP clients have no approval/signing tool. Provider execution is lazy, bounded and cleaned up on disable/shutdown. STRICT refuses stdio providers; managed Linux retains signed privileged approvals and temporary YOLO leases.

Portable mode is **not an OS sandbox**. SSH/private Git access, general package dependency resolution, community registry search and referenced/regex tool schemas are currently unsupported. Automatic packages are limited to dependency-free Node executables and universal Python wheels. [Exact supported formats and limits](docs/SOURCES.md).

## Documentation and license

[Platforms](docs/PLATFORM_SUPPORT.md) · [Sources](docs/SOURCES.md) · [Extensions](docs/EXTENSIONS.md) · [MCP integrations](docs/MCP_INTEGRATIONS.md) · [Security](docs/POLICY_GATEWAY.md) · [Managed Linux](docs/SYSTEMD_DEPLOYMENT.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Verification evidence](docs/COMPLETION_AUDIT.md)

[MIT licensed](LICENSE), derived from [chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder) by hoangcoderr; original attribution is preserved. Historical Go source remains on `archive/go-prototype`.
