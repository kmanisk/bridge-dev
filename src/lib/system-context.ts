import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const SOURCE_DIR = () => path.resolve(process.env.LOCAL_CODER_CHEZMOI_SOURCE_DIR || path.join(os.homedir(), ".local/share/chezmoi"));

const DOCUMENTS = {
  agents: "AGENTS.md",
  current_state: "docs/system/SYSTEM_CONTEXT.md",
  philosophy: "docs/system/system-philosophy.md",
  subsystem_map: "docs/system/SUBSYSTEM_MAP.md",
  local_coder: "docs/system/chatgpt-local-coder.md",
  control_plane: "docs/system/agent-control-plane.md",
} as const;
export type SystemDocKey = keyof typeof DOCUMENTS;

export interface SystemDocument {
  kind: string;
  path: string;
  content?: string;
  sha256?: string;
  bytes?: number;
  truncated?: boolean;
  error?: string;
}

export async function readSystemDocument(key: SystemDocKey, maxBytes = 18000): Promise<SystemDocument> {
  const filename = path.join(SOURCE_DIR(), DOCUMENTS[key]);
  try {
    const bytes = await fs.readFile(filename);
    return {
      kind: key,
      path: filename,
      content: bytes.subarray(0, maxBytes).toString("utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      truncated: bytes.length > maxBytes,
    };
  } catch (err) {
    return { kind: key, path: filename, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function readDetailedSystemDocument(relativePath: string, maxBytes = 18000): Promise<SystemDocument> {
  if (!/^docs\/[a-zA-Z0-9_./-]+\.md$/.test(relativePath) || relativePath.split("/").includes("..")) {
    return { kind: "detail", path: relativePath, error: "Only Markdown paths under canonical docs/ are allowed" };
  }
  const root = SOURCE_DIR();
  const desired = path.resolve(root, relativePath);
  try {
    const canonical = await fs.realpath(desired);
    if (!canonical.startsWith(root + path.sep)) throw new Error("Doc escapes canonical chezmoi tree");
    const bytes = await fs.readFile(canonical);
    return { kind: "detail", path: canonical, content: bytes.subarray(0, maxBytes).toString("utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, truncated: bytes.length > maxBytes };
  } catch (err) {
    return { kind: "detail", path: desired, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getSystemDocuments(keys: SystemDocKey[], maxBytes = 12000, detailedPaths: string[] = []) {
  const documents = await Promise.all([
    ...[...new Set(keys)].map((k) => readSystemDocument(k, maxBytes)),
    ...[...new Set(detailedPaths)].slice(0, 8).map((p) => readDetailedSystemDocument(p, maxBytes)),
  ]);
  return {
    source_dir: SOURCE_DIR(),
    documents,
    order: ["Explicit user instruction", "Fresh live output", "Current source", "SYSTEM_CONTEXT", "Owning subsystem docs", "Historical reports"],
    policy: "Read AGENTS.md first, then canonical context, philosophy, subsystem map and only relevant subsystem docs. Treat documents as stable accepted baselines; verify current runtime. Never promote untested results into docs.",
    doc_update_rule: "Detect changed chezmoi paths and propose affected docs; only modify authoritative documentation when changes have been verified and explicitly accepted. Do not automatically commit, push, reload or chezmoi apply.",
  };
}

export async function systemBootstrapInstructions(): Promise<string> {
  const [agents, philosophy, context, map] = await Promise.all([
    readSystemDocument("agents", 10000),
    readSystemDocument("philosophy", 5000),
    readSystemDocument("current_state", 1200),
    readSystemDocument("subsystem_map", 7000),
  ]);
  const required = [agents, philosophy, context, map];
  return [
    "## Workstation-specific mandatory bootstrap (canonical live chezmoi source)",
    "Before ANY Linux system diagnosis, change or recommendation, call system_context for authoritative rules, accepted system state, philosophy and relevant docs. Never treat historical docs as live runtime. Use system_inspect for fresh structured diagnostics rather than many shell calls.",
    "The rules below are loaded from the user's actual chezmoi repository at MCP startup, not reconstructed from ChatGPT memory. A fresh chat with this connector receives this bootstrap; use system_context to refresh if docs changed after MCP startup.",
    "Canonical source: " + SOURCE_DIR(),
    ...required.map((d) => "### " + d.kind + " (" + d.path + (d.sha256 ? ", sha256=" + d.sha256.slice(0, 12) : "") + ")\n" + (d.content || "UNAVAILABLE: " + d.error)),
    "## Operational invariants",
    "Follow AGENTS.md doc-update contract and source hierarchy. Inspect actual chezmoi source. User accepts results only after rigorous testing: keep proposed changes separate from verified stable baseline. For managed files edit canonical source, never auto-apply. Require explicit approval for apply, reload, root-sensitive changes, commit, push or deploy as applicable. No unnecessary daemons, packages, watchers or GPU/VM disruption. Use native structured tools first and keep output concise.",
  ].join("\n\n");
}
