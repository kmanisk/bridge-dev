export const MCP_QUICKSTART = `
## BridgeDev workflow
1. Read this workspace's AGENTS.md / CLAUDE.md and configured user Markdown instructions.
2. Explore with glob, grep, read_text_file; edit only approved paths with apply_patch or edit_file.
3. Verify with available builds and tests; report what was actually checked.
4. Use list_skills/load_skill for user-added skills.
5. Host-specific system_context, system_inspect, system_job and chezmoi_inspect are optional platform integrations.
6. Upstream MCP servers are optional; imported configs are not automatic execution permission.
7. Do not assume root privileges, unrestricted disk access, or YOLO approval.
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
