import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { getSecurityPolicy, type OperationClass } from "./security-policy.js";
import { sudoExec, isPermissionError, canUseSudo, statSafe } from "./sudo-fs.js";
import { assertChezmoiMutationAllowed } from "./chezmoi-guard.js";
import { validateConfigCandidate, type ValidationResult } from "./config-validator.js";

export interface SafeEditOptions {
  path: string;
  content: string | Buffer;
  expectedHash?: string;
  authToken?: string;
  dryRun?: boolean;
  preserveMetadata?: boolean;
}

export interface SafeEditResult {
  ok: boolean;
  path: string;
  operationClass: OperationClass;
  bytes: number;
  preImageHash: string | null;
  postImageHash: string;
  metadata: {
    mode: number;
    uid: number;
    gid: number;
  } | null;
  dryRun?: boolean;
  validation: ValidationResult;
}

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function executeSafeEdit(options: SafeEditOptions): Promise<SafeEditResult> {
  const resolvedPath = path.resolve(options.path);
  await assertChezmoiMutationAllowed(resolvedPath);
  const targetDir = path.dirname(resolvedPath);
  const policy = getSecurityPolicy();

  // 1. Check Symlink Traversal on Target Path
  try {
    const lstat = await fs.lstat(resolvedPath);
    if (lstat.isSymbolicLink()) {
      const realTarget = await fs.realpath(resolvedPath);
      const realAuth = policy.authorizeFileOperation(realTarget, "write", options.authToken);
      if (!realAuth.allowed) {
        throw new Error(`SECURITY_SYMLINK_BLOCKED: Symlink ${resolvedPath} points to restricted target ${realTarget}: ${realAuth.error}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if (!isPermissionError(err)) throw err;
    }
  }

  // 1b. Check Parent Directory Symlink Traversal
  try {
    let realTargetDir = targetDir;
    try {
      realTargetDir = await fs.realpath(targetDir);
    } catch (err) {
      if (isPermissionError(err) && canUseSudo()) {
        realTargetDir = (await sudoExec("realpath", [targetDir])).toString("utf-8").trim();
      }
    }
    if (realTargetDir !== targetDir) {
      const canonicalDest = path.join(realTargetDir, path.basename(resolvedPath));
      const dirAuth = policy.authorizeFileOperation(canonicalDest, "write", options.authToken);
      if (!dirAuth.allowed) {
        throw new Error(`SECURITY_SYMLINK_BLOCKED: Parent directory ${targetDir} resolves to restricted path ${realTargetDir}: ${dirAuth.error}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if (!isPermissionError(err)) throw err;
    }
  }

  // 2. Classify & Authorize Target Path
  const contentBuffer = typeof options.content === "string" ? Buffer.from(options.content, "utf-8") : options.content;
  const postImageHash = sha256(contentBuffer);

  const authCheck = policy.authorizeFileOperation(resolvedPath, "write", options.authToken, postImageHash);
  if (!authCheck.allowed) {
    throw new Error(authCheck.error || `SECURITY_BLOCKED: Operation not allowed on ${resolvedPath}`);
  }

  // 3. Inspect Existing Target & Capture Pre-image Hash and Content
  let preImageHash: string | null = null;
  let preImageBuffer: Buffer | null = null;
  let originalMetadata: { mode: number; uid: number; gid: number } | null = null;
  let fileExisted = false;

  try {
    const stat = await fs.stat(resolvedPath);
    fileExisted = true;
    originalMetadata = {
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
    };
    preImageBuffer = await fs.readFile(resolvedPath);
    preImageHash = sha256(preImageBuffer);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fileExisted = false;
    } else if (isPermissionError(err) && canUseSudo()) {
      fileExisted = true;
      try {
        preImageBuffer = await sudoExec("cat", [resolvedPath]);
        preImageHash = sha256(preImageBuffer);
        const statOut = (await sudoExec("stat", ["-c", "%a %u %g", resolvedPath])).toString("utf-8").trim();
        const [modeStr, uidStr, gidStr] = statOut.split(" ");
        originalMetadata = {
          mode: parseInt(modeStr, 8),
          uid: parseInt(uidStr, 10),
          gid: parseInt(gidStr, 10),
        };
      } catch {}
    } else {
      throw err;
    }
  }

  // 4. Optimistic Locking / Conflict Detection
  if (options.expectedHash && preImageHash && preImageHash !== options.expectedHash) {
    throw new Error(
      `CONFLICT_DETECTED: Target file ${resolvedPath} has been modified since it was read. Expected hash ${options.expectedHash}, found ${preImageHash}. Edit aborted to prevent data loss.`
    );
  }

  // 5. Validate the candidate before any file modification. Never reload services.
  const validation = await validateConfigCandidate(resolvedPath, contentBuffer);
  if (validation.status === "failed") {
    throw new Error("CONFIG_VALIDATION_FAILED (" + validation.validator + "): " + validation.detail);
  }

  // 6. Dry-run Mode
  if (options.dryRun) {
    return {
      ok: true,
      path: resolvedPath,
      operationClass: authCheck.operationClass,
      bytes: contentBuffer.length,
      preImageHash,
      postImageHash,
      metadata: originalMetadata,
      validation,
      dryRun: true,
    };
  }

  // 6. Atomic Staging via Temporary File in the Same Directory
  const tempFileName = `.tmp.${path.basename(resolvedPath)}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  const tempFilePath = path.join(targetDir, tempFileName);
  const isPrivileged = authCheck.operationClass === "privileged_edit" || authCheck.operationClass === "high_risk";

  try {
    if (!isPrivileged) {
      // User-level atomic transaction with durability
      await fs.mkdir(targetDir, { recursive: true });
      const handle = await fs.open(tempFilePath, "w");
      await handle.writeFile(contentBuffer);
      await handle.sync(); // fsync file content & metadata
      await handle.close();

      if (originalMetadata && options.preserveMetadata !== false) {
        try {
          await fs.chmod(tempFilePath, originalMetadata.mode);
        } catch {}
      }

      // Pre-rename race check: verify file did not drift immediately before commit
      if (fileExisted) {
        let currentHash: string | null = null;
        try {
          const curBuf = await fs.readFile(resolvedPath);
          currentHash = sha256(curBuf);
        } catch {
          currentHash = null;
        }
        if (currentHash !== preImageHash) {
          throw new Error(
            `CONFLICT_DETECTED: Destination file ${resolvedPath} was modified concurrently immediately before commit. Expected hash ${preImageHash}, found ${currentHash}. Atomic edit aborted.`
          );
        }
      }

      // Atomic rename
      await fs.rename(tempFilePath, resolvedPath);

      // fsync parent directory to ensure directory entry is flushed
      try {
        const dirHandle = await fs.open(targetDir, "r");
        await dirHandle.sync();
        await dirHandle.close();
      } catch {}
    } else {
      // Privileged atomic transaction using sudo
      if (!canUseSudo()) {
        throw new Error("Cannot perform privileged safe edit on platform without sudo support");
      }

      await sudoExec("mkdir", ["-p", targetDir]);
      await sudoExec("tee", [tempFilePath], contentBuffer);
      try {
        await sudoExec("sync", ["-d", tempFilePath]);
      } catch {}

      if (originalMetadata && options.preserveMetadata !== false) {
        try {
          const octalMode = (originalMetadata.mode & 0o7777).toString(8);
          await sudoExec("chmod", [octalMode, tempFilePath]);
          await sudoExec("chown", [`${originalMetadata.uid}:${originalMetadata.gid}`, tempFilePath]);
        } catch {}
      }

      // Pre-rename race check for privileged file
      if (fileExisted) {
        let currentHash: string | null = null;
        try {
          const curBuf = await sudoExec("cat", [resolvedPath]);
          currentHash = sha256(curBuf);
        } catch {
          currentHash = null;
        }
        if (currentHash !== preImageHash) {
          throw new Error(
            `CONFLICT_DETECTED: Destination file ${resolvedPath} was modified concurrently immediately before commit. Expected hash ${preImageHash}, found ${currentHash}. Atomic edit aborted.`
          );
        }
      }

      // Atomic replacement using mv -T
      await sudoExec("mv", ["-T", "-f", tempFilePath, resolvedPath]);

      try {
        await sudoExec("sync", ["-d", targetDir]);
      } catch {}
    }

    // 7. Post-Write Verification Readback & Automatic Rollback
    let readBackBuffer: Buffer;
    if (!isPrivileged) {
      readBackBuffer = await fs.readFile(resolvedPath);
    } else {
      readBackBuffer = await sudoExec("cat", [resolvedPath]);
    }

    const verifiedHash = sha256(readBackBuffer);
    if (verifiedHash !== postImageHash) {
      // AUTOMATIC ROLLBACK on verification failure
      try {
        if (fileExisted && preImageBuffer) {
          if (!isPrivileged) {
            await fs.writeFile(resolvedPath, preImageBuffer);
          } else {
            await sudoExec("tee", [resolvedPath], preImageBuffer);
          }
        } else if (!fileExisted) {
          if (!isPrivileged) {
            await fs.unlink(resolvedPath);
          } else {
            await sudoExec("rm", ["-f", resolvedPath]);
          }
        }
      } catch {}

      throw new Error(
        `VERIFICATION_FAILED: Written content hash (${verifiedHash}) did not match expected candidate hash (${postImageHash}). Destination was automatically rolled back.`
      );
    }

    return {
      ok: true,
      path: resolvedPath,
      operationClass: authCheck.operationClass,
      bytes: contentBuffer.length,
      preImageHash,
      postImageHash,
      metadata: originalMetadata,
      validation,
    };
  } catch (err) {
    // Clean up temporary staging file if left behind
    try {
      if (!isPrivileged) {
        await fs.unlink(tempFilePath);
      } else {
        await sudoExec("rm", ["-f", tempFilePath]);
      }
    } catch {}
    throw err;
  }
}
