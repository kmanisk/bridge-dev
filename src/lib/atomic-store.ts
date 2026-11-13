import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function withFileLock<T>(filename: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filename), {recursive:true, mode:0o700});
  const lock = filename + ".lock";
  let acquired = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await fs.mkdir(lock, {mode:0o700}); acquired = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!acquired) throw new Error("CONFIG_BUSY: another operation owns " + lock + "; inspect the owner before recovering a stale lock");
  try { return await action(); } finally { await fs.rmdir(lock); }
}
export async function atomicJson(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), {recursive:true,mode:0o700});
  const st = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {if(error.code !== "ENOENT")throw error; return null;});
  if(st && (!st.isFile() || st.isSymbolicLink()))throw new Error("CONFIG_UNSAFE_PATH");
  const temp = filename + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value,null,2) + "\n"); await handle.sync();
  } finally { await handle.close(); }
  try {
    // Recovery copy is an inert snapshot; malformed state is never silently restored.
    if(st)await fs.copyFile(filename, filename + ".bak");
    if(st)await fs.chmod(filename + ".bak",0o600);
    await fs.rename(temp, filename);
  } finally { await fs.rm(temp,{force:true}); }
}
