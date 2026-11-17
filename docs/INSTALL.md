# Install BridgeDev

## Updates and recovery

For a verified persistent Linux service, `bridge-dev update` prepares the
CI-verified release once and uses the shadow-acceptance route when the
independent YOLO lease is already active. The existing host lease is kept
unchanged across cutover; shadow denials use a temporary namespace and live
smoke is positive-only. This requires preinstalled `bwrap` and working
unprivileged namespaces. No new daemon or updater watcher is installed.
Use `bridge-dev update --standard-window` to opt into the older flow.

If an older installed CLI produces `SERVICE_GITHUB_ACCESS_FAILED`, inspect
the tracked service job and release pointer before retrying. The new
implementation reuses a previously CI-verified staged release rather than
re-fetching with `gh` from a transient systemd unit. GitHub errors report
specific missing-binary, auth, network or rate-limit categories.

The one-time bootstrap from an old CLI must be initiated using the verified
new CLI from a trusted built checkout in the operator's own terminal. Do
not automatically restore signed YOLO or change systemd hardening during
bootstrap. STANDARD-only and portable installations keep their existing
modes and update requirements.



## npm package

BridgeDev is packaged as a precompiled npm CLI: its tarball contains `dist/`,
`public/ui/`, reviewed portable profiles, required runtime scripts, and the
license and installation documentation. npm installs the production Node.js
dependencies automatically. No TypeScript build, pnpm, Git checkout, service or
root controller is required on the consumer machine.

After a registry release is explicitly published, the installation is:

~~~sh
npm install -g bridge-dev
bridge-dev setup
bridge-dev start
~~~

**Publication is a separate operator action.** Until the registry package is
published, create and inspect a local tarball instead:

~~~sh
pnpm install --frozen-lockfile --ignore-scripts
npm run test:package
npm pack
# In a disposable prefix, inspect and install the generated .tgz before use.
~~~

`npm run test:package` builds and checks the tarball in a temporary local
installation, verifies CLI/help and portable setup, and rejects excluded files.
The global npm command must not replace the launcher for an existing managed
BridgeDev installation. Its signed host-controller lease, systemd cutover and
rollback remain governed by the [separate managed update procedure](PERSISTENT_SERVICE.md).
For an **explicit initial** Linux service setup from an npm-installed CLI,
`bridge-dev service install --start` stages the *GitHub CI-verified release*
corresponding to the npm package's `vX.Y.Z` tag; it does not seed the unverified
npm files into an operator-privileged service. This advanced operation requires
the `gh` CLI authenticated for the release-artifact API, an already-published
tag and green main-branch CI. It does not create YOLO authorization or Funnel
exposure. Existing managed installations use their own operator CLI for
verified service updates; a standalone npm CLI only reports npm update guidance.

`bridge-dev --version` reports the packaged version. `bridge-dev doctor`
identifies the installation source. For npm installs, `bridge-dev update --check`
reports the manual update command `npm install -g bridge-dev@latest` and does
not invoke GitHub deployment or npm itself; the managed Linux updater is
unchanged. A standalone npm gateway must never inherit a different, managed
gateway's operator-signed YOLO authorization. See [release instructions](RELEASING.md).

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

**Portable mode:** `bridge-dev start` runs the gateway in the foreground. To obtain the Admin pairing and MCP connection URL while it is running, execute `bridge-dev access` from another private local terminal. It refuses to print secrets into redirected output or through a remote tool call. On Linux, `bridge-dev dashboard` can open a one-use local browser pairing link once the gateway is running. Windows/macOS should use `bridge-dev access`.

**Optional managed Linux user service:** follow [Persistent service](PERSISTENT_SERVICE.md) for one-time reviewed installation. After it is installed, `bridge-dev start` starts the service without occupying the terminal, and `bridge-dev dashboard` opens the authenticated local UI from the **same terminal**. The standard portable installer never silently creates or enables this service or installs a root controller.

The launcher directory may need to be on your shell PATH; the installer prints its full path and the relevant PATH command. Windows PowerShell installation adds the launcher directory to your user PATH for new terminals.

### Everyday use and simple checks

```sh
bridge-dev start           # Foreground portable gateway (Ctrl+C to stop)
bridge-dev access          # Private Admin/MCP connection details
bridge-dev doctor          # Diagnose installation and connectivity
bridge-dev help            # Supported commands on your installed version
```

On Linux, an **optional** persistent user service supports `bridge-dev service install`, `service status`, `service logs`, `service rollback`, and the single guarded `bridge-dev update` command. `bridge-dev update` checks exact-commit CI, stages the release, coordinates temporary STANDARD acceptance even when an existing YOLO lease is active, and offers independently confirmed reauthorization only after success. See [Persistent service](PERSISTENT_SERVICE.md). This service is distinct from the separately reviewed [host-root controller](HOST_CONTROLLER.md).

For ChatGPT, provide the HTTPS MCP URL from `bridge-dev access`; with a legacy token-in-path URL select **Authentication: None**. Keep the token and any private Admin URL out of logs, screenshots and GitHub issues. The dashboard stays local. Portable `system_context` may legitimately be unconfigured.

### Updating

Run the same installer command again. The existing private configuration and workspace are preserved; the runtime is rebuilt and the previous version is retained. The installer does **not** automatically restart a running gateway—stop it first if you want to use the updated version.

### Remote ChatGPT

ChatGPT Web cannot access a computer's localhost. Configure an HTTPS tunnel separately, forwarding only the authenticated MCP endpoint. Keep the Admin UI local, don't expose secrets, and refresh the ChatGPT connector after enabling new tools. Remote connectivity is not silently created by the installer.

### Production Linux installation

This portable install intentionally **does not alter** `chatgpt-local-coder-policygate.service`, root-owned policy, the sudo host controller, Tailscale Funnel, audit protection, or existing deployed releases. A managed Linux installation has a separately reviewed and documented [deployment procedure](DEPLOYMENT.md). Never run the public installer with sudo.

### Platform constraints

Native Linux, Windows and macOS runtime tests exist. Installer fixtures run on CI; actual remote account integrations and Android/Termux hardware still need acceptance. Termux may need `pkg install nodejs-lts curl tar`. Waydroid and rooted Android shells do not automatically grant the Linux host's sudo mode.

For local disposable tests, see [LOCAL_TRIAL.md](LOCAL_TRIAL.md). For support details, see [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md).
