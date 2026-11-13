import fs from "fs/promises";
import { spawn } from "child_process";
import path from "path";

export function isPermissionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

export function canUseSudo(): boolean {
  return process.platform !== "win32";
}

export function sudoExec(command: string, args: string[], input?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", command, ...args], {
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (d) => stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.stderr?.on("data", (d) => stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));

    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        const errText = Buffer.concat(stderrChunks).toString("utf-8").trim();
        const err = new Error(errText || `sudo ${command} exited with code ${code}`);
        if (errText.includes("No such file or directory")) {
          (err as NodeJS.ErrnoException).code = "ENOENT";
        }
        reject(err);
      }
    });

    child.on("error", reject);

    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export async function readFileSafe(filePath: string, encoding: "utf-8"): Promise<string>;
export async function readFileSafe(filePath: string, encoding: "buffer"): Promise<Buffer>;
export async function readFileSafe(filePath: string): Promise<string>;
export async function readFileSafe(filePath: string, encoding: "utf-8" | "buffer" = "utf-8"): Promise<string | Buffer> {
  try {
    if (encoding === "buffer") {
      return await fs.readFile(filePath);
    }
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      const buf = await sudoExec("cat", [filePath]);
      return encoding === "buffer" ? buf : buf.toString("utf-8");
    }
    throw err;
  }
}

export async function writeFileSafe(filePath: string, content: string | Buffer): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, typeof content === "string" ? "utf-8" : undefined);
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      await sudoExec("mkdir", ["-p", path.dirname(filePath)]);
      await sudoExec("tee", [filePath], content);
      return;
    }
    throw err;
  }
}

export async function unlinkSafe(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      await sudoExec("rm", ["-f", filePath]);
      return;
    }
    throw err;
  }
}

export async function mkdirSafe(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      await sudoExec("mkdir", ["-p", dirPath]);
      return;
    }
    throw err;
  }
}

export async function rmDirSafe(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      await sudoExec("rm", ["-rf", dirPath]);
      return;
    }
    throw err;
  }
}

export async function copyFileSafe(src: string, dest: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      await sudoExec("mkdir", ["-p", path.dirname(dest)]);
      await sudoExec("cp", ["-f", src, dest]);
      return;
    }
    throw err;
  }
}

export async function moveFileSafe(src: string, dest: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      await sudoExec("mkdir", ["-p", path.dirname(dest)]);
      await sudoExec("mv", ["-f", src, dest]);
      return;
    }
    throw err;
  }
}

export interface StatSafeResult {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export async function statSafe(filePath: string): Promise<StatSafeResult> {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      const output = (await sudoExec("stat", ["-c", "%s %F", filePath])).toString("utf-8").trim();
      const match = output.match(/^(\d+)\s+(.+)$/);
      if (match) {
        const size = parseInt(match[1], 10);
        const typeStr = match[2].toLowerCase();
        return {
          size,
          isFile: () => typeStr.includes("file"),
          isDirectory: () => typeStr.includes("directory"),
        };
      }
    }
    throw err;
  }
}

export interface DirEntrySafe {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export async function readdirSafe(dirPath: string): Promise<DirEntrySafe[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: () => e.isDirectory(),
      isFile: () => e.isFile(),
    }));
  } catch (err) {
    if (isPermissionError(err) && canUseSudo()) {
      const output = (await sudoExec("ls", ["-1pa", dirPath])).toString("utf-8");
      const lines = output.split("\n").map((l) => l.trim()).filter((l) => l && l !== "./" && l !== "../");
      return lines.map((line) => {
        const isDir = line.endsWith("/");
        const name = isDir ? line.slice(0, -1) : line;
        return {
          name,
          isDirectory: () => isDir,
          isFile: () => !isDir,
        };
      });
    }
    throw err;
  }
}
