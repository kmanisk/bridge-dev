export const MCP_QUICKSTART = `
## BridgeDev workflow
1. Read this workspace's AGENTS.md / CLAUDE.md and configured user Markdown instructions.
2. Explore with glob, grep, read_text_file; edit only approved paths with apply_patch or edit_file.
3. Verify with available builds and tests; report what was actually checked.
4. Use list_skills/load_skill for user-added skills.
5. Host-specific system_context, system_inspect, system_job and chezmoi_inspect are optional platform integrations.
6. Upstream MCP servers are optional; imported configs are not automatic execution permission.
7. Managed Linux exposes Read & Write for scoped everyday work and Full System (sudo) only after independent local Y/N confirmation and a short-lived signed root lease. Invalid authorization remains in the internal STRICT safety lock; remote clients never activate sudo themselves.
8. Before commands/writes in managed mode call system_context with docs=[agents,current_state]. Its result includes context_token and context_expires_at. If your MCP client opens a new session per tool call, copy context_token into the optional context_token argument of EACH later gated tool (including run_command). Otherwise retain Mcp-Session-Id. Reload when expired or source documents change. Never disclose the token; it does not approve sudo or privileged work.
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  _fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = "# BridgeDev MCP\nDefault workspace: "+workspaceRoot+
    "\nAccess: scoped by active policy and OS permissions. Never assume full-machine authority.";
  const footer = "## Available context\nWorkspace roots: "+workspaceRoots.join("; ")+
    "\nUse agent_status for capability details, project_context for other approved workspaces, list_skills for extensions.";
  return [header, MCP_QUICKSTART, contextBlock?.trim(), footer].filter(Boolean).join("\n\n");
}
