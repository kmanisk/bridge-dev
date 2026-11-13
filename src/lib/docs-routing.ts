import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root = () => path.resolve(process.env.LOCAL_CODER_CHEZMOI_SOURCE_DIR || path.join(os.homedir(), ".local/share/chezmoi"));
const rules: Array<[RegExp, string]> = [
  [/^(dot_config\/sway\/|dot_local\/bin\/executable_(sway|scratch|ui-scale|ui-sync))/, "docs/system/sway.md"],
  [/^(dot_config\/pipewire\/|dot_config\/wireplumber\/|dot_local\/bin\/executable_(audio|mic|speaker))/, "docs/audio/AUDIO_ARCHITECTURE.md"],
  [/(bluetooth|bt-|bluez)/, "docs/audio/2026-10-20_BLUETOOTH_AUDIO_STUTTER.md"],
  [/(nvidia|supergfx|vibrance)/, "docs/display/nvidia-vibrance.md"],
  [/(dot_config\/fish\/|dot_config\/foot\/|dot_config\/alacritty\/)/, "docs/system/terminal-shell.md"],
  [/(local-coder|agent-context|AGENTS\.md|agent-control)/, "docs/system/chatgpt-local-coder.md"],
  [/(dot_config\/theme\/|theme-)/, "docs/theme/theme-system.md"],
  [/(dot_config\/xremap\/|xremap)/, "docs/system/xremap.md"],
  [/(waydroid|venus)/, "docs/virtualization/waydroid-guide.md"],
  [/(btrfs|snapper|mount|storage)/, "docs/system/file-management.md"],
];
export function documentationPlanForPaths(paths: string[]) {
  const base = root();
  const affected: Array<{ source_path: string; suggested_owner_doc: string }> = [];
  for (const file of [...new Set(paths)]) {
    const resolved = path.resolve(file);
    const relative = path.relative(base, resolved).replaceAll("\\", "/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) || relative.startsWith("docs/")) continue;
    const owner = rules.find(([re]) => re.test(relative))?.[1] || "docs/system/SUBSYSTEM_MAP.md (select owning subsystem)";
    affected.push({ source_path: relative, suggested_owner_doc: owner });
  }
  if (!affected.length) return undefined;
  return {
    status: "pending_user_acceptance",
    reason: "Source changed in chezmoi. Validate runtime and user-approve before promoting observations to accepted documentation.",
    affected,
    required: [
      "Owning subsystem Markdown under docs/",
      "docs/system/SYSTEM_CONTEXT.md if cross-agent verified machine state or invariants changed",
      "docs/system/SYSTEM_CHANGELOG.md for durable system/config commits",
    ],
    automatic_actions: "Detection and recommendation only; no docs modified, no apply, no commit, no push.",
  };
}
