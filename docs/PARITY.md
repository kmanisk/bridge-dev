# BridgeDev Parity Matrix and Behavioral Specification

## Overview

This document serves as the authoritative specification of observable behavior for BridgeDev across the primary Node/TypeScript implementation and the Rust rewrite crates.

Any observable disagreement between Node and Rust is considered a bug until proven otherwise. Every behavioral difference, divergence, or intentional design variance must be recorded here along with its technical rationale and resolution.

## 1. Conformance Test Suite Mapping

The behavioral contract is formally codified in `tests/conformance/runner.mjs` and parameterized by `BRIDGE_IMPL_CMD` and `BRIDGE_GATEWAY_CMD`.

| Subsystem | Vector Specification | Conformance Suite | Observable Invariants |
| :--- | :--- | :--- | :--- |
| **MCP Streamable HTTP** | `vectors/mcp_protocol_vectors.json` | Suite 5 | Handshake negotiation, `Mcp-Session-Id` header tracking, 401 unauthenticated enforcement, native tool discovery |
| **Session Bounds** | `vectors/mcp_protocol_vectors.json` | Suite 5 | LRU session eviction upon reaching `MCP_MAX_SESSIONS` (default: 50), 30-minute idle session reaping |
| **Policy Engine** | `vectors/policy_vectors.json` | Suite 3.5 | Writable roots boundaries, `OUTSIDE_WRITABLE_ROOTS`, `SECRET_DENIED` on `.env` / SSH keys, high-risk command rejection |
| **Context Tokens** | `vectors/signature_vectors.json` | Suite 3 | HMAC-SHA256 token verification, expiry enforcement, cross-subject isolation, restart invalidation |
| **Operator Leases** | `vectors/signature_vectors.json` | Suite 3 | Ed25519 64-byte signature verification, `host-root-v1` scope check, nonce matching against `/var/lib/bridge-dev-operator/active-lease.json` |
| **Network & SSRF** | `vectors/ssrf_vectors.json` | Suite 1 | IPv4/IPv6 public unicast filtering, rejection of RFC 1918, CGNAT, loopback, link-local, IPv4-mapped IPv6, HTTPS enforcement |
| **Safe Archive** | `vectors/archive_vectors.json` | Suite 2 | `safeRelative` traversal rejection (`..`, `\`, null bytes, `__proto__`), max 1 MiB per file, 16 MiB total, symlink mode 0120000 refusal |
| **Provider Routing** | `vectors/provider_vectors.json` | Suite 5 | Deterministic `provider__tool` namespacing, independent provider collision isolation |
| **CLI Reporting** | CLI test vectors | Suite 4 | Deterministic JSON envelope `{ ok: boolean, command: string, output: string[] }`, authenticated `doctor --perf` output |

## 2. Observable Behavioral Differences and Resolutions

| Component | Node Implementation | Rust Implementation | Parity Status | Resolution / Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Session Memory** | Instantiates `McpServer` closures per session (~7.5 to 11.3 MiB per session) | Shared routing table with lightweight connection handles | Verified Parity | Memory bounded by design; Node uses LRU eviction (Phase 0), Rust uses zero-allocation sessions |
| **Process Model** | Single Node event loop with child processes for stdio providers | Multi-threaded Tokio async runtime with non-blocking stdio | Verified Parity | Observable protocol and error codes remain identical |
| **Hash Operations** | Node crypto streaming HMAC and SHA256 | Rust `ring` / `ed25519-dalek` / `sha2` | Identical | Base64 and Base64URL outputs bit-for-bit identical |
| **Error Envelopes** | Standard JSON-RPC 2.0 error codes and `{ isError: true, structuredContent: { ok: false, error: ... } }` | Identical JSON-RPC 2.0 structure | Identical | Strict conformance verified via JSON Schema |

## 3. Verification Protocol

The conformance test suite must be executed with:

```sh
pnpm run test:conformance
pnpm run test:conformance:mutation
```

No changes may be accepted if flakiness or mutation escape occurs.
