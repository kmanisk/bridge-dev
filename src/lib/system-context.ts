import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { hasHostContext } from "./runtime.js";
import {isReadPermissionError,readPermissionError} from "./read-errors.js";

const SOURCE_DIR = () => path.resolve(process.env.BRIDGEDEV_SYSTEM_CONTEXT_DIR || process.env.LOCAL_CODER_CHEZMOI_SOURCE_DIR || path.join(os.homedir(), ".local/share/chezmoi"));

const DOCUMENTS = {
  agents: ["AGENTS.md"],
  current_state: ["docs/SYSTEM_CONTEXT.md", "docs/system/SYSTEM_CONTEXT.md"],
  philosophy: ["docs/system-philosophy.md", "docs/system/system-philosophy.md"],
  subsystem_map: ["docs/SUBSYSTEM_MAP.md", "docs/system/SUBSYSTEM_MAP.md"],
  local_coder: ["docs/bridge-dev.md", "docs/system/chatgpt-local-coder.md"],
  control_plane: ["docs/control-plane.md", "docs/system/agent-control-plane.md"],
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
  const choices = DOCUMENTS[key];
  const root = SOURCE_DIR();
  let filename = path.join(root, choices[0]);
  for (const candidate of choices) {
    const test = path.join(root, candidate);
    try { await fs.access(test); filename = test; break; } catch {}
  }
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
    return { kind: key, path: filename, error: isReadPermissionError(err) ? readPermissionError("document", key).message : err instanceof Error ? err.message : String(err) };
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
    return { kind: "detail", path: desired, error: isReadPermissionError(err) ? readPermissionError("document", path.basename(relativePath)).message : err instanceof Error ? err.message : String(err) };
  }
}

export async function getSystemDocuments(keys: SystemDocKey[], maxBytes = 12000, detailedPaths: string[] = []) {
  if (!hasHostContext()) return {
    source_dir: null, documents: [], configured: false,
    message: "Host system context is optional. Configure BRIDGEDEV_SYSTEM_CONTEXT_DIR in a reviewed managed deployment; project guidance can use AGENTS.md and .bridge-dev/extensions.json.",
  };
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
  if (!hasHostContext()) return "";
  const [agents, philosophy, context, map] = await Promise.all([
    readSystemDocument("agents", 10000),
    readSystemDocument("philosophy", 5000),
    readSystemDocument("current_state", 1200),
    readSystemDocument("subsystem_map", 7000),
  ]);
  const required = [agents, philosophy, context, map];
  return [
    "## Optional host documentation (operator enabled)",
    "Before host system changes, inspect authoritative operator docs and verify the current runtime. Documentation does not grant OS privileges.",
    "Configured source: " + SOURCE_DIR(),
    ...required.map(d => "### " + d.kind + " (" + d.path + ")\n" + (d.content || "UNAVAILABLE: " + d.error)),
    "Do not infer system permissions from Markdown. Respect active policy, protected data, and operator approvals. Never auto-apply, reload, or publish unverified host changes.",
  ].join("\n\n");
}
