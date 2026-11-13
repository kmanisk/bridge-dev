export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Project memory + git state are already in MCP instructions from WORKSPACE_PATH. For Linux-system tasks, call system_context first; use system_inspect for compact current JSON diagnostics.
2. Call project_context(path) only for a different repo than WORKSPACE_PATH.
3. Explore with glob (file names) and grep (content), then read_text_file.
4. Edit with apply_patch (preferred), multi_edit, or write_file for new files.
5. Run builds/tests with run_command (short) or start_process + process_output (long).
6. Undo file edits with rewind (list → preview → restore). Shell/bash file changes are not tracked.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
- system_context: canonical kmanisk/dots AGENTS.md, SYSTEM_CONTEXT.md, philosophy, subsystem map and targeted docs (refresh when docs change)
- system_inspect: structured on-demand resources, GPU, storage, services, Sway, audio, Bluetooth and docs/config drift; no daemon
- system_job: recoverable transient user jobs (start/status/logs/stop/list); track ID/logs and verify exit
- chezmoi_inspect: resolve managed targets to source and detect generated outputs
- glob / grep / read_text_file: explore (offset+limit for partial reads)
- apply_patch: single-file @@ hunks OR multi-file *** Begin Patch format
- create_directory / delete_directory / copy_file / move_file / delete_file
- run_command: persistent shell (cd persists); shell_status / shell_reset
- git_status / git_diff / git_add / git_commit / git_branch / git_restore / git_stash
- rewind: action=list|preview|restore|status — undo file edits via automatic checkpoints
- enabled upstream MCP tools are exposed directly as <server>__<tool> (for example chrome-devtools__list_pages, linear__get_user); prefer direct tools
- mcp_servers / mcp_tools / mcp_call — upstream diagnostics/fallback when a direct proxy is unavailable
- git_push / git_checkout / delete_directory: may be blocked by ChatGPT safety — use run_command fallback

## apply_patch — single file
@@
-old line
+new line
 context unchanged

## apply_patch — multi file
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

## Paths & Privileges
BridgeDev Policy Gateway active: Workspace and mapped projects under /srv/bridge-dev (or /srv/local-coder). Privileged actions and out-of-boundary paths require operator approval. Full machine access is granted only when an authorized YOLO lease is active.
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = [
    "# BridgeDev MCP",
    `Default project: ${workspaceRoot}`,
    fullDiskAccess
      ? "Full machine & root access: ON (YOLO mode active). Tag this connector in ChatGPT before every task."
      : "BridgeDev Policy Gateway: STANDARD mode (UID: localcoder). Tag this connector in ChatGPT before every task.",
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Workspace roots: ${workspaceRoots.join("; ")}`,
    "agent_status — full tool cheat sheet + apply_patch format",
    "project_context(path) — load CLAUDE.md from another repo",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${footer}`;
  return `${header}\n\n${body}\n\n${footer}`;
}