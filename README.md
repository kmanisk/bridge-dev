# BridgeDev

**BridgeDev** is a self-hosted Model Context Protocol (MCP) gateway for development on a machine you control. Its implementation is TypeScript/Node.js, with auditable file editing, Git inspection, shell/process tools, contextual authorization and a signed-operator policy gateway.

This repository supersedes the former experimental Go implementation of BridgeDev. That prototype remains available in Git history; it is not part of the current source tree.

## Security modes

- **STRICT:** Read-only operations by default; changes require independent operator approval; privileged shell commands are refused.
- **STANDARD (default):** Ordinary work in explicitly mapped projects; privileged or destructive operations require independently signed approvals.
- **YOLO:** Temporarily leased full-system operations through a separately controlled privileged broker. Root access is **not** implicit in the MCP daemon, and the lease expires automatically.

The deployed gateway must run under a restricted OS service account. A signed approval does not override Linux filesystem or systemd restrictions. The operator key and audit anchor must remain outside the MCP process's write access.

## Repository layout

- `src/`: MCP server, tools, authorization and audit enforcement
- `scripts/`: tests, preflight and operator tooling
- `profiles/`: example tool, gateway and upstream configurations
- `deployment/`: illustrative service configuration, **not** an unattended installation
- `public/ui/`: authenticated localhost administration interface
- `docs/POLICY_GATEWAY.md`: threat model, configuration and verification details

## Development

Requires Node.js and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:policy
pnpm run test:all
```

The production preflight intentionally refuses insecure or unanchored installations. Do **not** expose a development instance, admin port or unsandboxed process to the public network.

## Deployment and compatibility

An existing private Local Coder-derived service may still use historical runtime paths, environment names and service identifiers. Those are **compatibility interfaces**, not the BridgeDev product name. Changing live services and connector endpoints requires a separately verified migration and rollback plan. No production host is modified by this repository migration.

## Provenance and licensing

BridgeDev's TypeScript gateway is derived from the MIT-licensed `chatgpt-local-coder` project by **hoangcoderr**, with extensive subsequent policy-gateway work. Keep the upstream MIT copyright notice in [LICENSE](LICENSE). The previous Go BridgeDev prototype is preserved in this repository's Git history.

Do not commit secrets, service environment files, OAuth tokens, operator private keys or audit ledgers.
