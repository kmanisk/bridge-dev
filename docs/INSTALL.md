# Install BridgeDev

## One-command portable installation

Requirements: **Node.js 22+ and npm**. The shell installer also needs `curl` and `tar`. Windows PowerShell requires `Invoke-WebRequest` and `Expand-Archive`.

**Linux/macOS/Termux**

~~~sh
curl -fsSL https://raw.githubusercontent.com/kmanisk/bridge-dev/main/install.sh | sh
~~~

**Windows PowerShell**

~~~powershell
irm https://raw.githubusercontent.com/kmanisk/bridge-dev/main/install.ps1 | iex
~~~

Download and inspect the scripts before executing them if you prefer. Both installers download a GitHub source archive and perform a **local npm install and TypeScript build** under your own OS account; BridgeDev is not yet published as an npm installer. No Git or pnpm installation is required.

### Where files go

| | Linux and Termux | macOS | Windows |
| --- | --- | --- | --- |
| Runtime | `~/.local/share/bridge-dev/app` | `~/Library/Application Support/BridgeDev/app` | `%LOCALAPPDATA%\BridgeDev\app` |
| Private config | `~/.config/bridge-dev/.env` | `~/Library/Application Support/BridgeDev/config/.env` | `%APPDATA%\BridgeDev\.env` |
| Launcher | `~/.local/bin/bridge-dev` | `~/.local/bin/bridge-dev` | `%LOCALAPPDATA%\BridgeDev\bin\bridge-dev.cmd` |
| Default workspace | `~/BridgeDevWorkspace` | `~/BridgeDevWorkspace` | `%USERPROFILE%\BridgeDevWorkspace` |

The installer creates separate random MCP/Admin tokens, tries ports 3000/3001 and selects different available loopback ports if occupied. Credentials remain in private configuration; they are **not printed in installer logs**. Config is preserved when reinstalling. The prior app directory is retained as `app.previous-<timestamp>` for recovery.

Start BridgeDev in the foreground using `bridge-dev start`. Run `bridge-dev access` in a second interactive terminal to display the local Admin UI URL, Admin token and MCP URL. The access command deliberately refuses to print secrets into redirected output or via a remote tool call.

The launcher directory may need to be on your shell PATH; the installer prints its full path and the relevant PATH command. Windows PowerShell installation adds the launcher directory to your user PATH for new terminals.

### Updating

Run the same installer command again. The existing private configuration and workspace are preserved; the runtime is rebuilt and the previous version is retained. The installer does **not** automatically restart a running gateway—stop it first if you want to use the updated version.

### Remote ChatGPT

ChatGPT Web cannot access a computer's localhost. Configure an HTTPS tunnel separately, forwarding only the authenticated MCP endpoint. Keep the Admin UI local, don't expose secrets, and refresh the ChatGPT connector after enabling new tools. Remote connectivity is not silently created by the installer.

### Production Linux installation

This portable install intentionally **does not alter** `chatgpt-local-coder-policygate.service`, root-owned policy, the sudo host controller, Tailscale Funnel, audit protection, or existing deployed releases. A managed Linux installation has a separately reviewed and documented [deployment procedure](DEPLOYMENT.md). Never run the public installer with sudo.

### Platform constraints

Native Linux, Windows and macOS runtime tests exist. Installer fixtures run on CI; actual remote account integrations and Android/Termux hardware still need acceptance. Termux may need `pkg install nodejs-lts curl tar`. Waydroid and rooted Android shells do not automatically grant the Linux host's sudo mode.

For local disposable tests, see [LOCAL_TRIAL.md](LOCAL_TRIAL.md). For support details, see [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md).
