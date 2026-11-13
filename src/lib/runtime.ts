import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicyConfig } from "./policy-gateway.js";

export type RuntimeMode = "portable" | "managed";

// Existing managed installations supply POLICYGATE_POLICY_FILE.
// Never silently fall back to portable if the operator supplied a policy.
export function getRuntimeMode(): RuntimeMode {
  if (process.env.POLICYGATE_POLICY_FILE?.trim()) return "managed";
  const value = process.env.BRIDGEDEV_RUNTIME_MODE?.trim().toLowerCase();
  if (value && value !== "portable" && value !== "managed") {
    throw new Error("BRIDGEDEV_RUNTIME_MODE must be portable or managed");
  }
  if (value === "managed") {
    throw new Error("Managed mode requires an explicit POLICYGATE_POLICY_FILE");
  }
  return "portable";
}

export function hasHostContext(): boolean {
  return getRuntimeMode() === "managed" &&
    Boolean(process.env.BRIDGEDEV_SYSTEM_CONTEXT_DIR || process.env.LOCAL_CODER_CHEZMOI_SOURCE_DIR);
}

export interface PortableCapabilities {
  platform: NodeJS.Platform;
  runtime: RuntimeMode;
  capabilities: Record<string, "available" | "optional" | "unsupported">;
}

export function platformCapabilities(platform: NodeJS.Platform = process.platform): PortableCapabilities {
  const runtime = getRuntimeMode();
  return {
    platform, runtime,
    capabilities: {
      workspace: "available",
      git: "available",
      commands: "available",
      markdown: "available",
      skills: "available",
      upstream_mcp: "optional",
      systemd: platform === "linux" ? "optional" : "unsupported",
      system_inspection: platform === "linux" ? "optional" : "unsupported",
      chezmoi: "optional",
      privileged_broker: platform === "linux" && runtime === "managed" ? "optional" : "unsupported",
    },
  };
}

export function portableWorkspace(): string {
  const raw = process.env.WORKSPACE_PATH?.split(";")[0]?.trim() || process.cwd();
  return path.resolve(raw);
}
export function portableStateDir(): string {
  return path.resolve(process.env.BRIDGEDEV_STATE_DIR || path.join(os.homedir(), ".bridge-dev", "state"));
}

export function makePortablePolicy(): PolicyConfig {
  const workspace = portableWorkspace();
  const state = portableStateDir();
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const home = os.homedir();
  return {
    profile: "standard", dangerous_enabled: false,
    context_files: [],
    writable_roots: [workspace],
    protected_paths: [state],
    secret_paths: [
      path.join(home, ".ssh"), path.join(home, ".gnupg"), path.join(home, ".aws"),
      path.join(home, ".kube"), path.join(home, ".config", "age"),
    ],
    secret_names: [".env", ".env.*", "*.pem", "*.key", "id_*", "*token*", "credentials.json"],
    approval_paths: [],
    sensitive_segments: [".ssh", ".gnupg", ".aws", ".kube", "secrets", "private", "keyrings"],
    hard_paths: [sourceRoot, state],
    allowed_commands: ["pwd", "id", "whoami", "git status", "git diff", "git log"],
    approval_commands: [
      "sudo", "doas", "su", "pkexec", "ssh", "scp", "curl", "wget",
      "git push", "systemctl", "pacman", "apt", "dnf", "brew", "winget",
    ],
    denied_commands: ["mkfs", "wipefs", "rm -rf /", "shutdown", "format"],
    proxy_tools: {},
    limits: {
      max_payload_bytes: 1048576,
      max_mutations_per_minute: 30,
      max_denials: 5,
      approval_timeout_ms: 30000,
    },
    audit_log: path.join(state, "audit.jsonl"),
  };
}
