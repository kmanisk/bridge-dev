# BridgeDev

**Self-hosted MCP development gateway for ChatGPT, Codex, and other coding agents.**

BridgeDev connects AI coding clients to tools on a machine you control: files, patches, Git, shell commands, process supervision, system inspection, and upstream MCP integrations. Its **policy gateway** provides scoped access, independently signed operator approvals, and an auditable execution boundary.

[![Policy Tests](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml/badge.svg)](https://github.com/kmanisk/bridge-dev/actions/workflows/policy-tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Language: TypeScript](https://img.shields.io/badge/TypeScript%20%2F%20Node.js-2.0-blue)](package.json)

> **Current implementation:** TypeScript / Node.js, not Go. This source replaces the original BridgeDev Go prototype. The old prototype remains recoverable in Git history.

## How it works

```text
ChatGPT / Codex / MCP client
            |
      MCP over HTTPS
            |
    Operator-managed tunnel (optional)
            |
    BridgeDev MCP server (:3000 loopback)
            |
      Policy gateway
      |-- Session context + scoped path rules
      |-- Strict / Standard / YOLO modes
      |-- Single-use Ed25519 operator approvals
      |-- Protected, hash-chained audit log
      |-- Files, patches, Git, shell + jobs
      |-- Upstream MCP tool bridge
            |
    Restricted OS account + approved projects
```

The admin interface is a **separate, authenticated, localhost-only** service, normally on port `3001`. Do not expose it through a public tunnel.

## What you can do

| Capability | Examples |
| --- | --- |
| Files and code | Read, write, edit, multi-edit, apply patches, search |
| Git | Inspect status, diffs, commits and branches; gate risky mutations |
| Commands | Run diagnostics, builds and tests; supervise process output |
| System context | Load canonical system docs, inspect runtime, resolve chezmoi sources |
| MCP integrations | Inspect configured upstream servers; authorize tool execution |
| Audit and recovery | Hash-chained records, explicit approvals, checkpoints and rewind |

The verified native registration inventory is **33 tools in the slim MCP profile / 55 in the full profile**. Some tools are intentionally gated or retired; discovery does not imply permission to execute arbitrary actions. See [the tool inventory](profiles/native-tool-counts.json).

## Three security modes

| Mode | Intended use | Restrictions |
| --- | --- | --- |
| **STRICT** | Audits and sensitive inspection | Read-only by default; writes/commands need operator approval, and sudo is denied |
| **STANDARD** (default) | Everyday development | Approved workspaces and routine commands work; privileged and destructive operations require signed approval |
| **YOLO / Full Access** | Deliberately authorized system maintenance | A time-limited, root-operator-signed lease enables a privileged broker; expiry returns to STANDARD |

**YOLO is not a permanent root daemon.** Mode activation requires an independent local operator action; a model or MCP client cannot issue its own trusted signing key or turn ordinary chat text into privileged authorization. Protect and verify your host OS account, key permissions, sudo broker, mount namespace, and audit storage.

For an *existing* operator-installed instance, mode commands use its installed `policygate-operator.mjs`, for example:

```sh
# From an independently controlled local operator terminal:
sudo node /opt/local-coder-policygate/scripts/policygate-operator.mjs mode standard
sudo node /opt/local-coder-policygate/scripts/policygate-operator.mjs mode strict
sudo node /opt/local-coder-policygate/scripts/policygate-operator.mjs yolo --duration 15
sudo node /opt/local-coder-policygate/scripts/policygate-operator.mjs yolo --off
```

These historical on-host paths are retained for **installed-version compatibility** until a separately tested BridgeDev service migration. They are not part of the public package's branding.

## Development

**Requirements:** Node.js, pnpm and Git. Tested CI uses **Node.js 24** and **pnpm 12**.

```sh
git clone https://github.com/kmanisk/bridge-dev.git
cd bridge-dev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run test:policy
pnpm run test:all
node scripts/sync-tool-counts.mjs --check-manifest profiles/native-tool-counts.json
```

Policy checks exercise isolated fixtures rather than changing your laptop's live services. CI validates the policy tests and tool manifest. The full local integration suite is separate from that CI gate.

The example [environment file](.env.example), [deployment unit](deployment/bridge-dev-policygate.service.example), and [security documentation](docs/POLICY_GATEWAY.md) are **reference material**, not a safe one-command production installer. A production gateway requires separately provisioned root-owned policy, signing keys, an append-only audit ledger, and a restricted service identity; production preflight rejects an incomplete setup.

## Connecting a client

The MCP listener defaults to `127.0.0.1:3000`. Once an operator has installed and started the gateway, a configured MCP client can use:

```text
http://127.0.0.1:3000/mcp/<MCP_TOKEN>
```

The token in this example is a placeholder. Remote clients require an appropriately secured **HTTPS** route and the same authorization controls. Keep the admin port loopback-only. Do not reuse sample tokens, expose the operator key, or start an unsandboxed production process.

The gateway enforces a `system_context` bootstrap for protected actions. Your client must discover and call it before edits or command execution when policy requires it.

## Repository structure

```text
src/                 Server, native MCP tools, policies, audit and utilities
scripts/             Operator tooling, preflight, verification and test fixtures
profiles/            Tool profiles and example configurations
public/ui/           Localhost admin UI
deployment/          Operator-reviewed systemd examples
docs/POLICY_GATEWAY.md  Security and deployment model
.github/workflows/   CI policy checks
```

## Safety and operational boundaries

- A privileged broker is intentionally separate from the MCP daemon; the daemon should run as a restricted non-login account.
- Canonical documentation can be mounted read-only, and writable projects should be explicitly mapped per project. Avoid exposing an entire home directory or granting broad recursive ACLs.
- Protected paths, operator keys and authentication secrets must not be writable by the MCP process.
- Audit records use SHA-256 chaining, a trusted anchor and OS append-only permissions.
- Source repository changes **do not automatically deploy** to an existing machine. Review and validate release upgrades, root-owned paths, connector URLs and rollback independently.
- Never commit `.env`, OAuth credentials, signing keys, audit ledgers or host-specific secrets.

## History and license

BridgeDev began as an experimental **Go** MCP prototype. That implementation has been replaced in the current source tree and remains available in the repository's Git history.

The TypeScript gateway is derived from the MIT-licensed [chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder) by **hoangcoderr**, with additional development and policy-gateway work. The original copyright notice is preserved in [LICENSE](LICENSE).

See [Policy Gateway documentation](docs/POLICY_GATEWAY.md) for the security model and [GitHub Actions](https://github.com/kmanisk/bridge-dev/actions) for current test status.
