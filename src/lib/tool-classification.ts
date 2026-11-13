import {MANAGEMENT_TOOL_CLASSES} from "../tools/extensions.js";
/** Closed-world native MCP tool registry. Every native registration must appear here. */
export type ToolClass = "R" | "W" | "X";

export const NATIVE_TOOL_CLASSES = {
  ...MANAGEMENT_TOOL_CLASSES,
  system_context: "R", system_inspect: "R", chezmoi_inspect: "R",
  read_text_file: "R", read_file_base64: "R", write_file: "W", write_file_base64: "W",
  edit_file: "W", multi_edit: "W", replace_regex: "W", apply_patch: "W",
  list_directory: "R", glob: "R", grep: "R", search_files: "R", directory_tree: "R",
  list_allowed_directories: "R", delete_file: "W", create_directory: "W",
  delete_directory: "W", copy_file: "W", move_file: "W",
  git_status: "R", git_diff: "R", git_log: "R", git_add: "W",
  git_commit: "W", git_branch: "W", git_checkout: "W", git_restore: "W",
  git_push: "W", git_pull: "W", git_stash: "W", git_reset: "W",
  run_command: "X", shell_status: "R", shell_reset: "W",
  start_process: "X", process_status: "R", process_output: "R",
  stop_process: "X", clear_processes: "X", system_job: "X",
  node_repl: "X", ponytail_turn: "X", rewind: "W",
  list_skills: "R", load_skill: "R", project_context: "R", agent_status: "R",
  remember: "W", load_path_rules: "R",
  mcp_servers: "X", mcp_tools: "R", mcp_call: "X",
} as const satisfies Record<string, ToolClass>;

export const EXPECTED_NATIVE_REGISTRATION_COUNT = 73;

export function classifyTool(name: string, args: Record<string, unknown>, overrides: Record<string, ToolClass> = {}):
  { kind: ToolClass; proxy: boolean; requiresProxyApproval: boolean } {
  if (name in NATIVE_TOOL_CLASSES) {
    let kind: ToolClass = NATIVE_TOOL_CLASSES[name as keyof typeof NATIVE_TOOL_CLASSES];
    if (name === "system_job") kind = ["list", "status", "logs"].includes(String(args.action)) ? "R" : "X";
    else if (name === "rewind") kind = ["list", "preview", "status"].includes(String(args.action ?? "list")) ? "R" : "W";
    else if (name === "git_branch" || name === "git_stash") kind = String(args.action ?? "list") === "list" ? "R" : "W";
    else if (name === "mcp_servers") kind = args.refresh === true ? "X" : "R";
    return { kind, proxy: false, requiresProxyApproval: false };
  }
  if (/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(name)) {
    return { kind: overrides[name] ?? "X", proxy: true, requiresProxyApproval: !(name in overrides) };
  }
  throw new Error("POLICYGATE_UNCLASSIFIED_TOOL: " + name + ". An operator must classify it before exposing this tool.");
}

export function assertRegistryComplete(registeredNames: Iterable<string>, includeBridge = true): void {
  const expected = Object.keys(NATIVE_TOOL_CLASSES).filter(name => includeBridge || !["mcp_servers","mcp_tools","mcp_call",...Object.keys(MANAGEMENT_TOOL_CLASSES)].includes(name));
  if (Object.keys(NATIVE_TOOL_CLASSES).length !== EXPECTED_NATIVE_REGISTRATION_COUNT) throw new Error("POLICYGATE_CLASSIFICATION_COUNT_MISMATCH: registry changed without updating count");
  const actual = [...registeredNames].filter((name) => !name.includes("__"));
  const missing = actual.filter((name) => !(name in NATIVE_TOOL_CLASSES));
  const stale = expected.filter((name) => !actual.includes(name));
  if (missing.length || stale.length || actual.length !== expected.length) {
    throw new Error("POLICYGATE_REGISTRY_DRIFT: unclassified=" + missing.join(",") +
      " missing_registrations=" + stale.join(",") + " actual=" + actual.length + " expected=" + expected.length);
  }
}
