import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface PostEditHook {
  glob: string;
  executable: string;
  args: string[];
  timeout_ms?: number;
}
interface HooksConfig { enabled?: boolean; hooks?: PostEditHook[] }

const DEFAULT_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../profiles/post-edit-hooks.json");
export function postEditHooksConfigPath(): string {
  return process.env.POST_EDIT_HOOKS_CONFIG || DEFAULT_CONFIG_PATH;
}

function matchGlob(input: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{ALL}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{ALL}}/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$", "i").test(input.replace(/\\/g, "/"));
}
async function readHooks(): Promise<HooksConfig> {
  try {
    const bytes = await fs.readFile(postEditHooksConfigPath(), "utf8");
    const config = JSON.parse(bytes) as HooksConfig;
    return Array.isArray(config.hooks) ? config : { enabled: false, hooks: [] };
  } catch { return { enabled: false, hooks: [] }; }
}
function executeHook(hook: PostEditHook, filePath: string): Promise<{ stdout: string; stderr: string; exit_code: number | null }> {
  const args = hook.args.map((arg) => arg.replaceAll("{path}", filePath).replaceAll("{file}", filePath));
  return new Promise((resolve) => {
    const child = spawn(hook.executable, args, { stdio: ["ignore", "pipe", "pipe"], cwd: path.dirname(filePath), shell: false });
    let stdout = "", stderr = "", settled = false;
    const done = (code: number | null, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.slice(0, 2000), stderr: (stderr + error).slice(0, 2000), exit_code: code });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(null, "hook timeout"); }, Math.min(Math.max(hook.timeout_ms ?? 5000, 100), 30000));
    child.stdout.on("data", (buf: Buffer) => { stdout = (stdout + buf.toString()).slice(0, 2000); });
    child.stderr.on("data", (buf: Buffer) => { stderr = (stderr + buf.toString()).slice(0, 2000); });
    child.on("error", (error) => done(null, error.message));
    child.on("close", (code) => done(code));
  });
}

export async function runPostEditHooks(filePaths: string[]): Promise<Record<string, unknown> | undefined> {
  const config = await readHooks();
  if (!config.enabled || !config.hooks?.length) return undefined;
  const results: Array<Record<string, unknown>> = [];
  for (const filePath of [...new Set(filePaths)]) {
    for (const hook of config.hooks) {
      if (!matchGlob(path.basename(filePath), hook.glob) && !matchGlob(filePath, hook.glob)) continue;
      if (!hook.executable || !Array.isArray(hook.args) || /^(sh|bash|zsh|fish|sudo|su|pkexec|doas)$/i.test(path.basename(hook.executable))) {
        results.push({ file: filePath, glob: hook.glob, status: "rejected", reason: "Only direct executable+argv validators allowed; shell and privileged wrappers forbidden." });
        continue;
      }
      const outcome = await executeHook(hook, filePath);
      results.push({ file: filePath, glob: hook.glob, validator: hook.executable, ...outcome });
    }
  }
  return results.length ? { post_edit_hooks: results } : undefined;
}
