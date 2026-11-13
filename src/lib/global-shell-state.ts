import { createHash } from "node:crypto";
import fs from "fs/promises";
import path from "path";

export interface GlobalShellState {
  workspace_key: string;
  cwd: string;
  updated_at: string;
  recent_commands: string[];
}

function getStateDir(): string {
  if (process.env.MCP_SHELL_STATE_DIR) return path.resolve(process.env.MCP_SHELL_STATE_DIR);
  if (process.env.HOME) return path.join(process.env.HOME, ".mcp-state");
  return path.join(process.cwd(), ".mcp-state");
}
const MAX_RECENT = 20;

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function statePath(workspaceRoot: string): string {
  return path.join(getStateDir(), `shell-${workspaceKey(workspaceRoot)}.json`);
}

export async function loadGlobalShellState(
  workspaceRoot: string,
  defaultCwd: string
): Promise<GlobalShellState | null> {
  try {
    const raw = await fs.readFile(statePath(workspaceRoot), "utf-8");
    const parsed = JSON.parse(raw) as GlobalShellState;
    if (!parsed.cwd) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveGlobalShellState(
  workspaceRoot: string,
  cwd: string,
  command?: string,
  previous?: GlobalShellState | null
): Promise<void> {
  const recent = [...(previous?.recent_commands ?? [])];
  if (command) {
    recent.push(command);
    while (recent.length > MAX_RECENT) recent.shift();
  }

  const state: GlobalShellState = {
    workspace_key: workspaceKey(workspaceRoot),
    cwd: path.resolve(cwd),
    updated_at: new Date().toISOString(),
    recent_commands: recent,
  };

  await fs.mkdir(getStateDir(), { recursive: true });
  await fs.writeFile(statePath(workspaceRoot), JSON.stringify(state, null, 2), "utf-8");
}

export async function restoreShellFromDisk(
  workspaceRoot: string,
  defaultCwd: string
): Promise<string> {
  const saved = await loadGlobalShellState(workspaceRoot, defaultCwd);
  return saved?.cwd ?? path.resolve(defaultCwd);
}