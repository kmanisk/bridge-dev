# MCP providers and aggregation

BridgeDev starts without external providers. HTTP and stdio providers are optional,
independently configured, and expose no tools by default. Registering a provider is
not proof of MCP compatibility or native dependency installation.

## Definitions and registration

Use a repository manifest or import a JSON MCP export:

```json
{
  "mcpServers": {
    "example": {"command": "node", "args": ["/reviewed/path/server.mjs"]}
  }
}
```

```sh
bridge-dev mcp add https://github.com/owner/compatible-provider
bridge-dev mcp import ./reviewed-export.json
bridge-dev approve <proposal-id>
bridge-dev mcp test example
```

Imports ignore incoming enable requests and register disabled, with no exposure.
Existing Cursor, Claude and OpenCode export parsing remains available in the admin
interface. A provider without reliable metadata requires an explicit definition;
BridgeDev never executes README installation commands or guessed entrypoints.

Portable registry is `<workspace>/.bridge-dev/mcp.json`; `MCP_UPSTREAM_CONFIG`
overrides it. The version-1 registry accepts `servers`, including command/args/env
for stdio or url/headers/bearer_token_env_var for HTTP. Managed registries must retain
the independently owned deployment permissions. User/project extension locks supply
owned definitions with project precedence. Existing explicit allowlists remain valid.

For local/private HTTP, review a version-1 definition with
`allow_private_network:true`. This grants access to private targets for that provider
only. It does not disable TLS/SSRF checks for source downloads. Missing prerequisites
or connectivity are reported as provider errors, not installed automatically.

## Lifecycle and permissions

```sh
bridge-dev mcp list
bridge-dev mcp info example
bridge-dev mcp test example
bridge-dev mcp tools example
bridge-dev mcp enable example --tools read_item,list_items --permission R
bridge-dev approve <enable-proposal-id>
bridge-dev mcp disable example
bridge-dev approve <disable-proposal-id>
bridge-dev mcp update example
bridge-dev approve <update-proposal-id>
bridge-dev mcp remove example
bridge-dev approve <remove-proposal-id>
```

`--allow-private-network` is an explicit enable-review option. Tool permissions are
operator assertions: R read-only, W mutation, X execution. A discovered read-only
annotation grants nothing. There is currently no automatic annotation-based grant.
Changed commands, arguments, source versions or hashes generate a new proposal;
updates reset enabling and require fresh review. `update --all` returns individual
proposals. Sources installed outside BridgeDev need provenance before automatic
updates can be computed. `search` currently searches installed metadata only.

States are separate: an artifact can be **installed**, a definition **registered**,
the provider **enabled**, its transport **connected**, and approved tools **exposed**.
A registered HTTP endpoint need not have an installed local artifact. Status and
metadata inspection are cached and do not execute providers; live tests require an
operator or signed MCP test approval. `logs` returns bounded, redacted diagnostics.

Portable mode accepts operator-reviewed per-tool permission declarations. Managed
Linux additionally requires its root-owned `proxy_tools` policy; an admin UI setting
does not supersede that independent policy. Unclassified tools require signed
per-call approval. STRICT refuses stdio; STANDARD permits reviewed processes under
the actual OS account. Portable mode cannot grant a privileged YOLO lease.

## Router behavior

Enabled providers initialize lazily for actual use/discovery, enumerate tools and
expose only approved names. Names use `<provider>__<tool>`, ASCII characters and at
most 64 characters; normalization/truncation adds a deterministic SHA-256 suffix.
Prefix and generated-name collisions fail closed.

Every call rechecks enablement and exposure, validates the original argument schema,
uses a timeout and validates/limits the result. Provider metadata/results are bounded
and labeled by untrusted origin. References/regex schema constructs are currently
unsupported; schemas that cannot be safely validated are refused. The SDK validates
declared structured output. Tool metadata cannot change policy or approve itself.

Calls are audited. Failed connections back off on demand; there is no provider poller.
Idle providers disconnect. Disable/remove/shutdown invalidate pending connections and
close owned process trees. POSIX uses process groups; Windows uses live-tree taskkill
and a bounded native snapshot helper for crashed roots. Windows cleanup was verified
with PowerShell 7 in CI; the legacy host fallback is not an equivalent isolation
boundary. Malicious providers can escape ordinary account-level process controls;
use independent OS isolation for untrusted execution.

Stdio receives explicit env grants. Windows SYSTEMROOT/WINDIR requirements appear in
reviewed configuration; libuv's other automatic variables are blanked. Gateway tokens
and approval authority are scrubbed from native command children. All environment
and header values are redacted from MCP provider inspection. HTTP credentials use
explicit protected environment references; OAuth uses private atomic files.

## MCP management tools

`extensions_list`, `extensions_info`, `extensions_search`,
`extensions_propose_add`, `extensions_propose_remove`, `mcp_list`, `mcp_info`,
`mcp_test`, `mcp_tools`, `mcp_status`, `mcp_propose_add`, `mcp_propose_update`,
`mcp_propose_remove`, `mcp_propose_disable`, `skills_list`, `skills_info`,
`skills_validate`, `skills_propose_add`, `skills_propose_remove`.

Proposals from clients are inert requests: no code is downloaded, installed,
approved, signed or enabled by creating a request. Authenticated operator review
resolves it to an exact preview. `mcp_test` additionally binds the exact provider
fingerprint and requires signed policy approval. There is no model approval tool.

Tool-list notifications are sent to active sessions. Clients may cache manifests;
refresh/reconnect the connector and open a new chat if new tools remain absent.
Provider prompts/resources are not aggregated; tool routing is the supported focus.

## Existing unversioned registries and explicit migration

Current schema is `{ "version": 1, "servers": [...] }`. The only accepted legacy
schema is the same `servers` array with **no version field** and no other root keys.
Numeric older/future versions and other layouts are unsupported. Empty files and
malformed JSON fail closed with sanitized errors. A missing optional file remains
an empty default. Invalid/unknown provider fields abort the entire load/migration;
no configured provider is silently skipped.

Legacy loading is read-only and in memory. CLI, MCP inspection and the Admin UI
report `configuration.source_schema: "legacy-unversioned"` and
`migration_required: true`. Providers are validated individually. Only a legacy
provider carrying explicit `reviewed:true` retains its recorded enabled/exposure
settings. Other legacy entries retain their definitions, credential references,
endpoint settings, allowlists and permission declarations, but load disabled with
`expose:"none"`. Never add `reviewed:true` merely to suppress review. Existing
version-1 enablement remains compatible. Runtime mutations refuse a legacy file
until an independent operator explicitly migrates it.

```sh
bridge-dev mcp migrate --config /operator/selected/mcp-upstream.json --dry-run --json
bridge-dev mcp migrate --config /operator/selected/mcp-upstream.json --json
```

This is a standalone operator file operation; it requires filesystem permission,
not a running admin service, and is not exposed as an MCP approval tool. `--dry-run`
performs no writes and prints the exact semantic JSON diff: adding `/version` and,
where required, replacing/adding individual `/servers/N/enabled` and `/expose`
fields. Unchanged provider data is never printed, keeping credential values out
of the preview. Applying takes the same exclusive registry lock as ordinary edits,
creates a mode-0600 sibling `mcp-upstream.json.backup-<UTC timestamp>-<random8>`,
fsyncs it and verifies it byte-for-byte/SHA-256 before writing a replacement.

The replacement uses a unique temporary file, preserves owner/group and permission
bits on POSIX, fsyncs and atomically renames after checking the original did not
change. Read-only directories/files produce a clear blocker and leave the original
untouched. A valid version-1 file is a no-op: no rewrite and no extra backup. Backups
are never loaded or restored automatically. An operator rollback restores the
verified backup through an atomic replacement with the original owner/mode, then
restarts only during an independently approved maintenance window.
