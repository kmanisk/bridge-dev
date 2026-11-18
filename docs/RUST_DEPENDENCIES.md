# Rust Workspace Dependencies and Justifications

## Overview

In accordance with BridgeDev architectural guidelines and Common Rules:
- Rust dependencies are strictly minimized and restricted to audited, high-assurance crates.
- Workspace lints enforce `unsafe_code = "forbid"` across all crates.
- Every dependency is justified below with its scope and technical necessity.

## Workspace Dependencies

| Crate | Version | Crates Utilizing | Justification & Scope |
| :--- | :--- | :--- | :--- |
| **`tokio`** | `1.41` | `bridge-gateway`, `bridge-cli` | De-facto standard asynchronous runtime for Linux networking, non-blocking I/O, timers, and signal handling. Features restricted to `macros`, `rt-multi-thread`, `net`, `time`, `signal`. |
| **`axum`** | `0.7` | `bridge-gateway` | High-performance, memory-safe HTTP web framework built on Tower and Hyper. Required for Streamable HTTP MCP transport and administrative routes. |
| **`serde`** | `1.0` | All workspace crates | Canonical zero-copy serialization/deserialization framework for JSON-RPC 2.0 messages and configuration schemas. Features: `derive`. |
| **`serde_json`** | `1.0` | All workspace crates | High-performance JSON parser and value representation. Required for JSON-RPC 2.0 protocol envelopes and vector verification. |
| **`ed25519-dalek`** | `2.1` | `bridge-crypto` | Pure-Rust implementation of Ed25519 digital signature algorithm. Required for verifying root operator leases against `operator-public.pem`. Zero C dependencies. |
| **`hmac`** | `0.12` | `bridge-crypto` | Pure-Rust generic HMAC implementation (RFC 2104). Required for context capability token issuance and verification. |
| **`sha2`** | `0.10` | `bridge-crypto`, `bridge-audit` | Pure-Rust SHA-256 implementation. Required for audit ledger chain hashes and context document fingerprints. |
| **`base64`** | `0.22` | `bridge-crypto` | RFC 4648 Base64 and Base64URL encoding/decoding. Required for context tokens and Ed25519 lease signatures. |
| **`clap`** | `4.5` | `bridge-cli` | Declarative, memory-safe command-line argument parser. Features: `derive`. |
| **`reqwest`** | `0.12` | `bridge-cli` | Minimal asynchronous HTTP client for `bridge-dev doctor --perf` querying local gateway endpoints. Features: `json`. |
| **`tracing`** | `0.1` | `bridge-gateway`, `bridge-cli` | Structured, non-blocking diagnostic logging without allocation overhead. |
| **`tracing-subscriber`** | `0.3` | `bridge-gateway`, `bridge-cli` | Formatting layer for tracing events to stdout/stderr. Features: `env-filter`. |

## Security Invariants

- `unsafe_code = "forbid"` is enforced at workspace level.
- No dynamic C library links (OpenSSL / libssl) are permitted; all crypto is pure-Rust or uses native OS random sources.
- No unmaintained or abandoned crates.
