# Platforms and runtime profiles

BridgeDev separates its **portable workspace gateway** from **optional host-specific operations**.

## Portable (all hosts)

Requirements: Node.js 20+ (CI: 24), pnpm and Git. \`pnpm install --frozen-lockfile --ignore-scripts && pnpm build\`, then copy \`.env.example\` to \`.env\`, set a generated \`MCP_TOKEN\` and \`WORKSPACE_PATH\`, run \`pnpm start\`.

Portable mode is selected when no \`POLICYGATE_POLICY_FILE\` is supplied. It:
- Binds only to loopback and refuses a non-loopback \`HOST\`.
- Limits ordinary filesystem mutation to \`WORKSPACE_PATH\`.
- Has no automatic root privileges, privileged approval broker or systemd dependency.
- Uses \`~/.bridge-dev/state/audit.jsonl\` as an application audit log, not a root-owned forensic ledger.
- Does not read workstation-wide agent files by default.
- Loads project \`AGENTS.md\` / \`CLAUDE.md\` and opt-in \`.bridge-dev/extensions.json\`.
- Starts with zero upstream MCP providers until the operator explicitly configures them.

**Important:** A process running under your regular account can still access any files that OS account can access through indirectly executed commands. This is not a container or an OS sandbox. Use a restricted OS account, container or hardened Linux installation to isolate untrusted code. A signed policy approval cannot substitute for OS-level isolation.

## Linux

Portable mode works independently of distribution package managers. Install Node.js, Git and pnpm using the distribution's package manager or a supported version manager:

- Arch / CachyOS: \`sudo pacman -S nodejs pnpm git\`
- Debian / Ubuntu: available distro packages may be older than the Node.js minimum; check \`node --version\` and use a supported Node.js distribution if needed
- Fedora: \`sudo dnf install nodejs git\`, then install pnpm using Corepack or its official installation instructions

These installation commands change host packages; they are **manual prerequisites**, never actions the MCP gateway runs automatically.

For root-owned policy, append-only audit and systemd sandboxing, consult [SYSTEMD_DEPLOYMENT.md](SYSTEMD_DEPLOYMENT.md). This is an additional operator-managed installation, not a portable default. The current production examples retain some historical compatibility paths.

## Windows

The Node.js source/portable tests are validated on \`windows-latest\` GitHub Actions. Run PowerShell:

~~~powershell
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
Copy-Item .env.example .env
# Edit MCP_TOKEN and WORKSPACE_PATH privately
pnpm start
~~~

Windows PowerShell service management and full host isolation are separate integrations, not provided by the Linux systemd runtime. The portable core's code and tests are checked, but a complete signed-operator Windows service deployment has **not** been accepted.

## macOS

The Node.js source/portable tests are validated on \`macos-latest\` GitHub Actions. Install Node.js, pnpm and Git via Homebrew or official installers, then follow the portable steps.

macOS launchd and sandbox/entitlements are **not** equivalent to the hardened Linux host mode; no systemd, \`chattr\` or root broker is assumed.

## Android / Termux

Experimental only. Termux can install Node.js and Git:

~~~sh
pkg install nodejs-lts git
# Install pnpm in a Termux-compatible way, then clone and build
~~~

Foreground loopback-only service access may work on supported phones. No Android CI, background service guarantee, systemd isolation, signed privileged broker or cross-app filesystem access is claimed. PRoot, if used, is **not** a substitute for kernel-enforced isolation.

## Optional capabilities

\`bridge-dev setup\` reports the platform and which modules are portable, optional or unsupported. System diagnostics, hardware integrations, computer-use tools and project bind mounts depend on the host and are never injected into every user's bootstrap instructions.

Use [EXTENSIONS.md](EXTENSIONS.md) for local Markdown/skills and [MCP_INTEGRATIONS.md](MCP_INTEGRATIONS.md) for upstream servers.
