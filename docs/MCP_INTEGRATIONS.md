# MCP integrations

BridgeDev is usable with only its built-in tools. Upstream MCP servers are **optional** and disabled by default.

## A project-owned registry

For portable mode, create \`.bridge-dev/mcp.json\` inside your project:

~~~json
{
  "version": 1,
  "servers": [
    {
      "id": "local-example",
      "name": "Local example",
      "enabled": false,
      "transport": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "tool_prefix": "example",
      "expose": "none"
    }
  ]
}
~~~

No servers are started or connected by default. Use explicit \`enabled\` and \`expose\` values only after reviewing the target and its permissions.

For a reviewed managed Linux deployment, set \`MCP_UPSTREAM_CONFIG\` to its independently owned registry. The repository's \`profiles/mcp-upstream.json\` is intentionally empty and contains **no developer-specific paths**.

## HTTP and stdio

- **HTTP:** Set \`transport:"http"\` with a full URL. Use TLS for remote endpoints. Tokens belong in environment variables or protected secret stores, not committed configuration.
- **stdio:** Set \`transport:"stdio"\` with \`command\` and \`args\`. A stdio provider executes code under the service account and inherits its accessible files unless independently isolated; this is a security-sensitive change.
- **Tool visibility:** \`expose:"none"\` hides tools, \`meta_only\` permits reviewed metadata, and \`allowlist\` permits only named tools in \`tools\`. \`all\` exposes every returned tool and should be avoided for untrusted providers.

Import tooling in the admin UI can read supported client configuration formats, but importing is **not** proof that a provider is safe. Review each command/URL, environment variable and tool allowance before enabling it. Refresh and reconnect only after deliberate operator action.

## Recommended order

1. Start BridgeDev with no upstream providers.
2. Add local Markdown/skills for your workspace.
3. Add one provider to \`.bridge-dev/mcp.json\` with \`enabled:false\` and \`expose:"none"\`.
4. Review credentials, transport, executable paths and tool classifications.
5. Enable only the needed tools and verify the new MCP client session.

See [EXTENSIONS.md](EXTENSIONS.md) and [POLICY_GATEWAY.md](POLICY_GATEWAY.md) for security boundaries.
