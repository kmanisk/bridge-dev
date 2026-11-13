# BridgeDev MCP Integrations

BridgeDev acts as an MCP gateway and tool hub, allowing AI coding assistants to access multiple upstream MCP servers through a single unified endpoint.

## Overview

```text
ChatGPT / Codex
       |
  BridgeDev (port 3000)
       |
       +---> Native Tools (filesystem, git, shell, patches)
       +---> Upstream MCP 1 (stdio: e.g., postgres, sqlite)
       +---> Upstream MCP 2 (http: e.g., custom API bridge)
```

## Configuring Upstream Servers

Upstream servers are configured in `mcp-upstream.json` (located at `/etc/bridge-dev/mcp-upstream.json` or `.mcp-upstream.json` in local development).

### 1. Stdio Transport Example
For local command-line tools running via standard input/output:

```json
{
  "servers": [
    {
      "id": "sqlite",
      "name": "SQLite Database",
      "enabled": true,
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "/srv/bridge-dev/workspace/app.db"],
      "expose": "all",
      "tool_prefix": "db_"
    }
  ]
}
```

### 2. HTTP Transport Example
For remote or containerized MCP services:

```json
{
  "servers": [
    {
      "id": "github",
      "name": "GitHub Integration",
      "enabled": true,
      "transport": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "auth": {
        "type": "none"
      },
      "expose": "allowlist",
      "tools": ["list_issues", "create_pull_request"],
      "tool_prefix": "gh_"
    }
  ]
}
```

## Importing Configurations

BridgeDev can import existing MCP configurations from popular coding environments through the localhost Admin UI (`http://127.0.0.1:3001`):

- **Cursor:** Automatically scans `~/.cursor/mcp.json` or project `.cursor/mcp.json`.
- **Claude Code:** Scans `~/.claude/claude_desktop_config.json`.
- **OpenCode:** Scans `~/.config/opencode/mcp.json`.

Imports are non-destructive and merge with existing servers without overwriting.

## Tool Profiles & Allowlisting

- **`all`:** Exposes all tools discovered from the upstream server, prefixed by `tool_prefix`.
- **`allowlist`:** Exposes only the explicitly listed tools.
- **`meta_only`:** Discovers tools but does not expose them until individually authorized.
