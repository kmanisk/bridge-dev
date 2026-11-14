# BridgeDev Policy Gateway

BridgeDev is a self-hosted Model Context Protocol server with server-side authorization, immutable deployment assumptions and an independently controlled operator trust boundary.

## Architecture

- Run the MCP process as a dedicated non-login OS account, without general root or unrestricted sudo.
- Keep its executable runtime and policy root-owned and not writable by the service UID.
- Scope writable roots to explicitly mapped projects. Map canonical system-context documentation read-only; never bind an entire user home or expose credentials to the service.
- Use a protected append-only JSONL audit log with a chained SHA-256 digest and an independent root-owned anchor. The correct deployed file model is `root:localcoder` mode `0660` with a `0750` parent directory and Linux `+a` append-only attribute.
- Reject operations before required system-context bootstrap and invalidate context after canonical documentation changes.
- Filter secret paths and names, prevent Git external diffs, helpers and text conversion from executing as read-only tools, and keep upstream MCP metadata discovery cached until authorized.
- Signed operator requests bind exact tool arguments, target and expiry; approvals are one-time and replay resistant.

## Modes

| Mode | Behavior |
| --- | --- |
| STRICT | Read-only by default; writes and executable actions require independent signed approval; sudo denied |
| STANDARD | Routine development inside explicitly approved roots; privileged/destructive commands need operator approval |
| YOLO | Explicit temporary operator-signed lease enables privileged broker operations until expiry; never persistent |

Do not assume that application-level checks alone protect the host. Shell and upstream code may be indirect execution channels. Linux UID separation, filesystem permissions, namespace restrictions and operator independence remain essential.

## Development verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run test:policy
pnpm run test:all
node scripts/sync-tool-counts.mjs --check-manifest profiles/native-tool-counts.json
```

The example deployment unit is a template, not an installer. Historical `LOCAL_CODER_*`, `/opt/local-coder`, or `chatgpt-local-coder` identifiers may remain as compatibility interfaces until a separately validated live-service rename. Existing deployed system identities, tokens, disks, user projects and service routing must not be changed by a repository rebrand.

## Provenance

Derived from the MIT-licensed `chatgpt-local-coder` codebase by hoangcoderr, with subsequent security-gateway work. Keep `LICENSE` intact.

## Context authorization and HTTP session continuity

A transport `Mcp-Session-Id` maps to one `PolicySession`, with its own random policy
ID and context digest. `system_context` must successfully return the configured
agents and current-state documents in that session. Authorization hashes the actual
loaded full-file digests and configured paths; runtime inspection output and HTTP
request timestamps do not participate. Missing documents or a change during loading
cannot grant authorization. A later source change clears the grant until a fresh
load, even if the old bytes are subsequently restored.

Keep the same `Mcp-Session-Id` on later calls. Ordinary SSE/HTTP reconnect to a live
session preserves that session. Recovery of a missing/expired session creates a
fresh policy session and requires its own context load. Headerless discovery remains
compatible, but each headerless request creates a different session. The SDK
already returns its session ID; the gateway now exposes that header through CORS
so browser clients can retain it. A client
that initializes a new session for every tool call can explicitly carry the
short-lived context token described below. The server never guesses identity from
IP address, client name or User-Agent and never implicitly shares session grants.

### Explicit context capability for stateless clients

After a successful HTTP `system_context`, its structured data includes a
`context_token` and `context_expires_at`. Copy the token into the optional
`context_token` argument of subsequent native tools when session continuity is
unavailable. Provider tools advertise a separate `_bridge_context_token` argument
(with another leading underscore if the provider already owns that name); the
gateway removes only its capability field before forwarding arguments.

The HMAC-SHA256 capability binds the authenticated HTTP credential fingerprint, exact
context digest, issuing policy session and expiry (at most five minutes). It is
request-scoped: using it never authorizes the recipient transport's later
tokenless calls. An unrelated client without the explicit capability stays denied.
The issuer's DELETE, expiry, context invalidation or gateway restart revokes it.
Reload after expiry/context changes; stale tokens remain invalid when old context
bytes are restored. Audit records omit tokens. This capability proves context
loading only and never approves a privileged operation or changes permissions.

**Shared-credential limitation:** The authenticated subject is currently the SHA-256
fingerprint of the single configured `MCP_TOKEN`, not a unique ChatGPT OAuth
grant. Connections sharing that secret are not independently identified. BridgeDev
therefore does not automatically inherit context authorization across unrelated
sessions. An explicit `context_token` is a short-lived bearer capability for the
authenticated subject; another connection holding both the shared MCP credential
and that explicit token can use it until expiry/revocation. Keep both private.
Any future grant-scoped automatic continuity first requires verified, distinct,
revocable authentication identities per client connection.

See [HOST_CONTROLLER.md](HOST_CONTROLLER.md) for optional host-root YOLO execution,
signed STANDARD execution, detached jobs, rollback and the limits of root leases.
Installed controllers and the gateway share a protected activation/mode record;
a copied signed lease cannot reactivate either layer after revocation. Full-host
signatures include their scope so legacy gateways cannot accept them on rollback.

DELETE revokes policy authorization immediately; the transport's brief cleanup grace
period does not restore it. TTL is checked on access as well as during periodic
cleanup. Shutdown clears grants. `context_authorization` events record `granted`,
`invalidated` and `denied`, with policy and transport session IDs and reason codes.
Document bodies, credentials and authorization digests are not logged in these events.
Signed approvals, strict/standard policy, protected paths and audit integrity remain
independent requirements after context authorization. An unallowlisted command such
as `agent-context system` may still require signed approval after loading context.

Regression: `scripts/test-managed-session-http.mjs` uses independent real HTTP MCP
clients with synthetic managed policy, documents, credentials, audit and providers.
