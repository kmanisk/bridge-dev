# BridgeDev

**Self-hosted Model Context Protocol (MCP) development gateway with policy enforcement, scoped workspaces, and signed operator approvals.**

BridgeDev connects AI coding assistants (ChatGPT, Claude Code, Codex, and other MCP clients) to developer tools on your own machines: files, patches, Git, shell execution, process supervision, system inspection, and upstream MCP integrations. Its policy gateway enforces strict isolation boundaries, audit logging, and out-of-band operator control.

[![Policy Tests](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)

---

## Quick Links

- [Platform Support](#platform-support)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Essential Commands](#essential-commands)
- [Configuration](#configuration)
- [Security Architecture](#security-architecture)
- [Documentation Links](#documentation-links)
- [License and Credits](#license-and-credits)

---

## Platform Support

| Platform | Tier | Runtime & Notes |
|---|---|---|
| **Linux** (Arch, CachyOS, Ubuntu/Debian, Fedora) | **Supported** | Native Node.js 20+, systemd service isolation (`ProtectHome=yes`, `ProtectSystem=strict`), append-only audit ledger (`chattr +a`), ACLs. |
| **Windows** (10 / 11) | **Supported** | Native Node.js 20+, PowerShell management (`start.ps1`, `stop.ps1`, `tunnel.ps1`), Cloudflare / Tailscale tunnels. |
| **macOS** (12+ Intel & Apple Silicon) | **Supported** | Native Node.js 20+, zsh/bash foreground or launchd agent. |
| **Android** (Termux) | **Experimental** | Userland Node.js in Termux. Systemd is unsupported; filesystem isolation relies on PRoot containerization. |

---

## Installation

### Prerequisites
- **Node.js:** version 20.0.0 or higher
- **Package Manager:** `pnpm` (recommended) or `npm`
- **Git:** for repository clone and version control operations

### 1. Linux (Arch / Debian / Ubuntu / Fedora)
```bash
# Clone repository
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev

# Install dependencies and build
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

For production deployment with a dedicated systemd service and sandboxing, see [Hardened Linux Systemd Deployment](docs/SYSTEMD_DEPLOYMENT.md).

### 2. Windows (PowerShell)
```powershell
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
Copy-Item .env.example .env
```

### 3. macOS (Terminal)
```bash
brew install node pnpm
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

### 4. Android (Termux — Experimental)
```bash
pkg install nodejs-lts git
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
npm install
npm run build
```

---

## Quick Start

### 1. Configure Environment
```bash
cp .env.example .env
```
Generate a secure authentication token and set it in `.env`:
```bash
node dist/cli.js login
# Copy the token and set MCP_TOKEN in your .env file
```

### 2. Start the Gateway
```bash
# Start foreground development server (defaults to port 3000)
pnpm start
```

### 3. Connect Your Coding Assistant
BridgeDev exposes an authenticated MCP endpoint at `/mcp`:

- **Endpoint URL:** `http://127.0.0.1:3000/mcp` (or your HTTPS tunnel URL)
- **Authentication:** Bearer token (`MCP_TOKEN`)

Run the built-in helper to view full connection parameters:
```bash
node dist/cli.js connect
```

---

## Essential Commands

BridgeDev provides a compact CLI (`bridge-dev` or `node dist/cli.js`):

| Command | Purpose | Description |
|---|---|---|
| `bridge-dev` | Status overview | Displays product version, daemon state, mode, project, and endpoint. |
| `bridge-dev status` | Detailed status | Queries process state, active sessions, and health status. |
| `bridge-dev connect` | Connection parameters | Prints MCP URL and client configuration blocks (use `--show-token` to reveal). |
| `bridge-dev mode` | View/Switch mode | Inspects or sets security mode (`strict`, `standard`, `yolo`). |
| `bridge-dev project` | Workspace management | Maps or unmaps local project directories into the sandbox. |
| `bridge-dev doctor` | Diagnostics | Validates Node runtime, port listeners, keypairs, and audit ledger. |
| `bridge-dev login` | Authentication | Inspects current token or generates a cryptographically secure token. |
| `bridge-dev setup` | Environment check | Verifies directory paths, permissions, and configuration. |
| `bridge-dev restart` | Restart daemon | Restarts the running service and confirms health recovery. |
| `bridge-dev stop` | Stop daemon | Stops the running service cleanly. |
| `bridge-dev help` | Help menu | Shows all CLI commands and available options. |

---

## Configuration

BridgeDev reads configuration from `.env` in local development, or `/etc/bridge-dev/service.env` in production.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TOKEN` | *(Required)* | Secret Bearer authentication token for MCP clients. |
| `PORT` | `3000` | Port for the main MCP gateway listener. |
| `ADMIN_PORT` | `3001` | Port for the localhost-only admin UI and status API. |
| `WORKSPACE_PATH` | `cwd` | Default directory root for client tool actions. |
| `CHATGPT_TOOL_PROFILE` | `slim` | Native tool profile: `slim` (33 tools) or `full` (55 tools). |
| `SHELL_TIMEOUT` | `120` | Command execution timeout in seconds. |
| `CHECKPOINT_ENABLED` | `false` | Enable snapshot and rollback checkpoints before file modifications. |
| `POLICYGATE_POLICY_FILE`| `/etc/bridge-dev/policy.json` | Path to JSON security policy file. |
| `POLICYGATE_APPROVAL_DIR`| `/var/lib/bridge-dev/approvals`| Storage directory for signed operator approvals. |

The admin web interface is available at **`http://127.0.0.1:3001`** (loopback only). Never expose port 3001 through a public tunnel.

---

## Security Architecture

BridgeDev uses a multi-tiered security gateway to protect the host machine:

### Three Operational Modes

1. **STRICT:**
   - Read-only inspection by default.
   - Any file modification, patch, or command execution requires out-of-band operator approval.
   - `sudo` and root escalation are completely blocked.

2. **STANDARD (Default):**
   - Designed for daily development inside approved project directories.
   - Routine file edits, Git inspection, and approved shell commands execute without friction.
   - Privilege escalation (`sudo`) and sensitive system mutations require signed operator approval.

3. **YOLO / Full Access:**
   - Time-limited emergency maintenance mode (maximum 120 minutes).
   - Requires explicit local interactive root confirmation to sign an Ed25519 lease.
   - Automatically expires and reverts to STANDARD mode upon lease timeout.

### Security Guarantees
- **No Unrestricted Sudo:** The MCP daemon runs under an unprivileged user and cannot grant itself root privileges.
- **Single-Use Signed Approvals:** Operator approvals bind the exact SHA-256 hash of the command or patch arguments and expire quickly.
- **Append-Only Forensic Audit:** Every tool call and decision is logged to an immutable, append-only ledger (`chattr +a`) with SHA-256 chain integrity.
- **Context Bootstrap:** AI clients must bootstrap system context before executing sensitive mutations.

---

## Documentation Links

- [Security Policy & Gateway Architecture](docs/POLICY_GATEWAY.md)
- [Hardened Linux Systemd Deployment](docs/SYSTEMD_DEPLOYMENT.md)
- [Upstream MCP Tool Integrations](docs/MCP_INTEGRATIONS.md)
- [Troubleshooting & Rollback Runbook](docs/TROUBLESHOOTING.md)

---

## License and Credits

BridgeDev is open-source software licensed under the [MIT License](LICENSE).

Copyright (c) 2026 kmanisk.

Derived from the MIT-licensed `chatgpt-local-coder` project by hoangcoderr, extended with a hardened TypeScript policy gateway, three-tier security modes, cryptographic approvals, and system sandboxing.
