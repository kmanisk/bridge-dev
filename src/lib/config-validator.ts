import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runReadOnly } from "./system-inspect.js";
import { spawn } from "node:child_process";

export interface ValidationResult {
  status: "passed" | "failed" | "pending" | "not_applicable";
  validator?: string;
  detail?: string;
  output?: string;
}
async function commandWithStdin(executable: string, args: string[], bytes: Buffer, timeoutMs = 5000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let complete = false;
    const finish = (code: number | null, error = "") => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve({ code, output: (output + error).slice(0, 2000) });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null, "validator timeout"); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (b: Buffer) => { output = (output + b.toString()).slice(0, 2000); });
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}

export async function validateConfigCandidate(filePath: string, contents: string | Buffer): Promise<ValidationResult> {
  const buffer = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  const posix = filePath.replace(/\\/g, "/");
  const basename = path.basename(filePath);
  if (basename.endsWith(".tmpl")) return { status: "pending", detail: "Chezmoi template must be rendered and validated against complete target before applying." };

  if (posix.includes("/sway/")) return { status: "pending", validator: "sway -C", detail: "Sway source fragment or full config requires complete chezmoi-rendered candidate validation before live apply; no compositor reload performed." };

  if (basename.endsWith(".json")) {
    try { JSON.parse(buffer.toString("utf8")); return { status: "passed", validator: "JSON.parse" }; }
    catch (err) { return { status: "failed", validator: "JSON.parse", detail: err instanceof Error ? err.message : String(err) }; }
  }
  let executable: string | undefined;
  let args: string[] = [];
  if (posix.includes("/fish/") || basename.endsWith(".fish")) { executable = "fish"; args = ["-n"]; }
  else if (basename.endsWith(".sh") || basename === ".bashrc" || basename === ".bash_profile") { executable = "bash"; args = ["-n"]; }
  else if (/\.(service|timer|socket|target|mount|path)$/.test(basename)) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-unit-"));
    try {
      const unit = path.join(temp, basename);
      await fs.writeFile(unit, buffer, { mode: 0o600 });
      const result = await runReadOnly("systemd-analyze", ["verify", unit], 5500, 2100);
      return result.ok
        ? { status: "passed", validator: "systemd-analyze verify", output: result.stderr.slice(0, 700) }
        : { status: "failed", validator: "systemd-analyze verify", detail: result.stderr.slice(0, 1400) || "Nonzero exit" };
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  if (!executable) return { status: "not_applicable", detail: "No safe targeted syntax validator for this file type." };
  const result = await commandWithStdin(executable, args, buffer);
  if (result.code === null) return { status: "pending", validator: executable + " -n", detail: result.output || "Validator unavailable" };
  if (result.code !== 0) return { status: "failed", validator: executable + " -n", detail: result.output || "Syntax invalid" };
  return { status: "passed", validator: executable + " -n" };
}
