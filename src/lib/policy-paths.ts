import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { PolicyConfig } from "./policy-gateway.js";
import type { ToolClass } from "./tool-classification.js";

const home = os.homedir();
// Never permit the MCP server to change its own installed implementation,
// even if the JSON policy accidentally omits the correct deployment path.
const executingPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function within(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}
/** Resolve symlinks in all existing ancestors. Dangling symlinks fail closed. */
export function canonicalPath(raw: string, cwd = process.env.WORKSPACE_PATH?.split(";")[0] || process.cwd()): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) throw new Error("POLICYGATE_PATH_INVALID");
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2))
    : raw.startsWith("$HOME/") ? path.join(home, raw.slice(6)) : raw;
  const absolute = path.resolve(cwd, expanded);
  let segment = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      const info = fs.lstatSync(segment);
      // fs.realpathSync fails for dangling symbolic links; never follow these for writes.
      let real: string;
      try { real = fs.realpathSync.native(segment); }
      catch (error) {
        if (info.isSymbolicLink()) throw new Error("POLICYGATE_DANGLING_SYMLINK: " + segment);
        throw error;
      }
      if (info.isSymbolicLink() && !fs.existsSync(real)) throw new Error("dangling symlink");
      const resolved = path.resolve(real, ...suffix.reverse());
      return resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("POLICYGATE_PATH_UNRESOLVABLE: " + absolute + ": " + String(err));
      }
      const parent = path.dirname(segment);
      if (parent === segment) throw new Error("POLICYGATE_PATH_UNRESOLVABLE: " + absolute);
      suffix.push(path.basename(segment));
      segment = parent;
    }
  }
}
function patternRegex(glob: string): RegExp {
  const escaped = glob.replace(/[\\^$+?.()|{}[\]]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$", "i");
}
export function isSecretPath(resolved: string, config: PolicyConfig): boolean {
  if (config.secret_paths.some((root) => within(resolved, root))) return true;
  const parts = resolved.split(path.sep).filter(Boolean);
  if (parts.some((segment) => config.sensitive_segments.includes(segment))) return true;
  return parts.some((segment) => config.secret_names.some((mask) => patternRegex(mask).test(segment)));
}
export function isHardPath(resolved: string, config: PolicyConfig, policyFile: string): boolean {
  return within(resolved, executingPackageRoot) ||
    within(resolved, policyFile) || within(resolved, config.audit_log) ||
    config.hard_paths.some((root) => within(resolved, root));
}
export function checkPath(raw: string, kind: ToolClass, config: PolicyConfig, policyFile: string, cwd?: string):
  { resolved: string; approval: boolean } {
  const resolved = canonicalPath(raw, cwd);
  if (isSecretPath(resolved, config)) throw new Error("POLICYGATE_SECRET_DENIED: " + resolved + "; never request credentials, private keys or secret paths.");
  if (kind === "R") return { resolved, approval: false };
  if (isHardPath(resolved, config, policyFile))
    throw new Error("POLICYGATE_HARD_PATH_DENIED: " + resolved + "; only the operator outside MCP may edit this path.");
  if (config.protected_paths.some((root) => within(resolved, root)))
    throw new Error("POLICYGATE_PROTECTED_PATH_DENIED: " + resolved);
  if (!config.writable_roots.some((root) => within(resolved, root)))
    throw new Error("POLICYGATE_OUTSIDE_WRITABLE_ROOTS: " + resolved + "; request an operator policy change.");
  return { resolved, approval: config.approval_paths.some((root) => within(resolved, root)) };
}
export function pathsFromArgs(tool: string, args: Record<string, unknown>, defaultCwd: string):
  Array<{ path: string; kind: ToolClass }> {
  const results: Array<{ path: string; kind: ToolClass }> = [];
  const add = (value: unknown, kind: ToolClass) => {
    if (typeof value === "string" && value.trim()) results.push({ path: value, kind });
  };
  if (tool === "system_context") {
    const source = process.env.LOCAL_CODER_CHEZMOI_SOURCE_DIR || path.join(home, ".local/share/chezmoi");
    for (const relative of Array.isArray(args.detailed_paths) ? args.detailed_paths : []) {
      if (typeof relative === "string") add(path.resolve(source, relative), "R");
    }
    return results;
  }
  if (tool === "remember") {
    const slug = createHash("sha256").update(path.resolve(defaultCwd)).digest("hex").slice(0, 12);
    add(path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "projects", slug, "MEMORY.md"), "W");
    return results;
  }
  if (tool === "shell_reset") { add(args.path ?? defaultCwd, "R"); return results; }
  if (["system_inspect","system_job","agent_status","shell_status",
    "process_output","process_status","stop_process","clear_processes","ponytail_turn","mcp_servers",
    "mcp_tools","mcp_call","node_repl","list_skills","load_skill"].includes(tool)) return results;
  if (["run_command","start_process"].includes(tool)) { add(args.working_directory, "R"); return results; }
  if (tool === "copy_file") { add(args.source,"R"); add(args.destination,"W"); return results; }
  if (tool === "move_file") { add(args.source,"W"); add(args.destination,"W"); return results; }
  if (tool === "git_restore") {
    add(args.path ?? defaultCwd,"R");
    for (const file of Array.isArray(args.files) ? args.files : [])
      if (typeof file === "string") add(path.resolve(String(args.path ?? defaultCwd),file),"W");
    return results;
  }
  if (tool.startsWith("git_")) {
    const isRead = ["git_status","git_diff","git_log"].includes(tool) ||
      (["git_branch","git_stash"].includes(tool) && (args.action === undefined || args.action === "list"));
    add(args.path ?? defaultCwd, isRead ? "R" : "W");
    return results;
  }
  if (tool === "rewind") return results; // restore checkpoint content must be checked separately.
  if (tool === "apply_patch") {
    const supplied = String(args.path ?? defaultCwd);
    const absolute = canonicalPath(supplied, defaultCwd);
    let base = absolute;
    try { if (!fs.statSync(absolute).isDirectory()) base = path.dirname(absolute); }
    catch { base = path.dirname(absolute); }
    const diff = String(args.patch ?? "");
    const paths = [...diff.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)]
      .map(m => m[1]);
    // Codex patch syntax is "*** Move to: <path>", not "Move to File:".
    paths.push(...[...diff.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)].map(m => m[1]));
    paths.push(...[...diff.matchAll(/^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+)$/gm)]
      .map(m => m[1]).filter(p => p !== "/dev/null"));
    if (paths.length === 0) {
      // Plain unified hunks modify the direct target; it is never a read-only operand.
      add(supplied, "W");
    } else {
      for (const target of paths) add(path.resolve(base, target), "W");
    }
    return results;
  }
  if (tool === "load_path_rules") { add(args.path, "R"); return results; }
  if (tool === "project_context") { add(args.path ?? defaultCwd, "R"); return results; }
  if (tool === "read_text_file" || tool === "read_file_base64" || tool === "grep" || tool === "glob" ||
      tool === "list_directory" || tool === "search_files" || tool === "directory_tree" ||
      tool === "chezmoi_inspect") { add(args.path, "R"); return results; }
  add(args.path, "W");
  return results;
}
