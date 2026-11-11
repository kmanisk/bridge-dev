# Local client registration

Reviewed 2026-11-11 against installed Codex 0.167.1 help (`mcp add`, `get --json`,
`remove`) and the [official Claude Code MCP reference](https://code.claude.com/docs/en/mcp).
Claude Code user scope is stored in ~/.claude.json. Bridge uses the documented
native add/remove commands with --scope user and --transport stdio; it refuses an
unverified custom CLAUDE_CONFIG_DIR location and offers --print instead.

Install asks before changing anything. Native CLI commands preserve unrelated
entries. A private receipt records the complete resulting Bridge entry's digest.
Uninstall rechecks ownership and refuses changed entries. Installed stdio args use
an absolute executable, explicit roots/mode and a private configuration snapshot
that preserves the selected policy. Editing Bridge's main configuration afterward
requires deliberate reinstall; it never silently promotes an installed client.

--print changes nothing and shows literal argv with explicit preferences, using
an existing configuration when available. Shell quoting is not implied by the
argv preview; Fish's `string escape` can prepare individual arguments if needed.

Claude Desktop always generates a mergeable JSON snippet. Open Settings /
Developer / Edit Config and preserve other mcpServers entries. The official MCP
[server guide](https://modelcontextprotocol.io/docs/develop/build-server) documents
macOS's ~/Library/Application Support/Claude/claude_desktop_config.json. Bridge
does not guess unofficial Linux Desktop configuration locations. Manual Desktop
registration also requires manual removal of that entry. A GUI client without a
controlling terminal cannot approve gated calls or privileged startup phrases;
manual ack_privileged is a deliberate advanced choice, never written by install.

These are registration checks, not proof of an authenticated AI conversation.
The actual Codex CLI add/get/remove was verified in temporary CODEX_HOME; fake
Claude binaries cover the equivalent argv and ownership flows. Claude Code,
Desktop, and real provider account conversations remain manual checks.
