# BridgeDev — repository handoff

BridgeDev is the TypeScript/Node.js MCP development gateway with signed operator approvals and a restricted OS deployment model. This repository **replaces the historical Go prototype**; its source remains accessible in Git history, not in the current working tree.

## Source and verification

- Canonical code: `https://github.com/kmanisk/bridge-dev`, branch `main`.
- Build and test: `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build`, `pnpm run test:policy`, `pnpm run test:all`.
- GitHub Actions `policy-tests` additionally verifies the registered MCP tool inventory against `profiles/native-tool-counts.json`.
- Retain the upstream MIT license and copyright in `LICENSE`.

## Deployment boundary

A source-repository rename **does not rename or restart** an already-installed production service. Existing installations may still use `local-coder` paths, `LOCAL_CODER_*` environment keys, original systemd unit names and connector IDs for backward compatibility.

The privileged operator CLI, root-owned policy and Ed25519 signing key, append-only ledger and immutable code must be installed by an independent operator under a restricted service account. Do not install from an agent tool call or bypass production preflight.

See `docs/POLICY_GATEWAY.md` for the model and `README.md` for repository layout. Never commit live tokens, OAuth credentials, key material, private audit trails, or host-specific service environment files.

## Operations

- STRICT: operator-signed approval for writes/exec; sudo forbidden.
- STANDARD: scoped development with signed approval for privileged or destructive requests.
- YOLO: short-lived independently operator-signed escalation lease; never persistent.

A rollout of the BridgeDev **name** into live service paths or public connector names requires its own verified rollout and rollback procedure; preserve the legacy fallback until then.
