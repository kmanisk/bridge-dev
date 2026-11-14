# BridgeDev

**Connect ChatGPT Web and other AI agents to your computer's files, terminal, Git projects and MCP tools.**

BridgeDev is a self-hosted MCP gateway for filesystem access, commands, code editing, skills and external MCP integrations. You choose which workspaces and tools the agent can use.

[![Policy tests](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml)
[![Linux / Windows / macOS](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/portable-platforms.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Install

**Requires:** Node.js **22+** with npm. No Git, pnpm, TypeScript, administrator privileges or background service needed for the standard portable install.

| Linux / macOS / Termux (shell) | Windows (PowerShell) |
| --- | --- |
| `curl -fsSL https://raw.githubusercontent.com/kmanisk/bridge-dev/main/install.sh \| sh` | `irm https://raw.githubusercontent.com/kmanisk/bridge-dev/main/install.ps1 \| iex` |

The installer downloads the current GitHub source, builds BridgeDev, creates a private configuration and two independent credentials, picks available localhost ports, and installs the `bridge-dev` launcher in your user directory. No system configuration or existing gateway is replaced. Updates retain your workspace, configuration and prior runtime.

**After installation:**

```sh
bridge-dev start
```

The gateway runs in the foreground. In another **private terminal**, run `bridge-dev access` to view the local Admin UI login and MCP connection details. Press Ctrl+C to stop the gateway. The installer prints the launcher's full path if it is not yet on `PATH`.

<details>
<summary>Android / Termux and other environments</summary>

In Termux, install `nodejs-lts`, `curl` and `tar` using `pkg` if missing, then run the same shell installer. **Termux and Waydroid are experimental until device-tested**; standard Android shell/root permissions are not equivalent to the managed Linux controller.

Windows dual-boot installations and Windows VMs use the PowerShell command **inside that Windows environment**. They are separate installations and do not modify the Linux host or VM configuration.

</details>

[Installation details, paths and troubleshooting](docs/INSTALL.md)

## Features

- **Computer tools:** Read, search, create and edit workspace files; run commands; inspect and change Git projects.
- **One MCP endpoint:** Use BridgeDev with ChatGPT, Codex, Claude or another compatible MCP client.
- **Extensions and skills:** Discover and review MCP providers, `SKILL.md` content and instructions from GitHub, URLs or local sources.
- **Admin UI:** See enabled providers, tool access and reviewed proposals.
- **User-controlled access:** Normal Read & Write mode; optional managed Linux Full System (sudo) mode.

## Connect ChatGPT Web

`bridge-dev access` displays the local URL and login details. **ChatGPT Web cannot connect directly to `localhost`**. To use it remotely, expose only the authenticated MCP endpoint through a separately configured HTTPS tunnel; never expose the local Admin UI.

When using the managed gateway, call `system_context` before commands. If the ChatGPT connector uses separate MCP sessions, forward the returned short-lived `context_token` to context-gated tools. This token does not grant sudo permissions. [Policy and session details](docs/POLICY_GATEWAY.md).

## Access modes

| Mode | Use |
| --- | --- |
| **Read & Write** | Scoped workspace files, Git and regular commands; standard portable and managed development |
| **Full System (sudo)** | Managed **Linux only**: unrestricted host-root access after independent terminal confirmation; stays active until switched off |

For an already provisioned managed Linux installation:

```sh
bridge-dev mode read-write
bridge-dev mode sudo
bridge-dev mode sudo --off
```

Full System displays `Enable Full System (sudo)? [Y/n]`. Press Enter or `y` to approve, or `n` to decline. Use `--duration 60` for an optional timed session. **The portable installer does not install the privileged host controller or automatically activate sudo.** [Linux controller setup](docs/HOST_CONTROLLER.md).

## Platforms

| Platform | Status |
| --- | --- |
| Linux (including Arch/CachyOS, Debian, Fedora, Ubuntu) | Portable runtime and distribution CI tested |
| Windows | Portable runtime tested in native CI |
| macOS | Portable runtime tested in native CI |
| Android / Termux / Waydroid | Experimental; device acceptance pending |

## Documentation

[Install](docs/INSTALL.md) · [Local trial](docs/LOCAL_TRIAL.md) · [Platform support](docs/PLATFORM_SUPPORT.md) · [MCP integrations](docs/MCP_INTEGRATIONS.md) · [Skills and extensions](docs/EXTENSIONS.md) · [Managed deployment](docs/DEPLOYMENT.md) · [Security](docs/POLICY_GATEWAY.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

## License

[MIT](LICENSE). Based on [chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder) by hoangcoderr; upstream attribution retained. The historical Go prototype is preserved in `archive/go-prototype`.
