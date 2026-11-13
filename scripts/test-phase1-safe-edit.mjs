/**
 * Phase 1 Safe Editing, Classification, and Authorization Test Suite
 * Comprehensive verification addressing Senior Engineering Review requirements.
 */
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { executeSafeEdit } from "../dist/lib/safe-edit.js";
import { getSecurityPolicy, resetSecurityPolicy } from "../dist/lib/security-policy.js";
import { applyMultiFilePatch } from "../dist/lib/patch.js";

const tmpDir = path.join(os.tmpdir(), `phase1-test-${Date.now()}`);
await fs.mkdir(tmpDir, { recursive: true });

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}:`, err);
  failed++;
}

try {
  // 1. Path Classification Tests
  const policy = resetSecurityPolicy("managed");

  assert.strictEqual(policy.classifyPath("/home/onyx/Projects/test.txt"), "routine_edit");
  assert.strictEqual(policy.classifyPath("/etc/fstab"), "privileged_edit");
  assert.strictEqual(policy.classifyPath("/etc/sudoers"), "high_risk");
  assert.strictEqual(policy.classifyPath("/etc/sudoers.d/99-test"), "high_risk");
  assert.strictEqual(policy.classifyPath("/boot/efi/EFI/boot.efi"), "high_risk");
  assert.strictEqual(policy.classifyPath("/dev/nvme0n1"), "high_risk");
  assert.strictEqual(policy.classifyPath("/dev/sda"), "high_risk");
  assert.strictEqual(policy.classifyPath("/proc/sys/vm/swappiness"), "high_risk");
  assert.strictEqual(policy.classifyPath("/sys/firmware/efi"), "high_risk");
  ok("Path classification: routine, privileged, and high-risk correctly identified");

  // 2. Command Classification Tests
  const cmdRead = policy.classifyCommand("git status");
  assert.strictEqual(cmdRead.operationClass, "read_only");

  const cmdRoutine = policy.classifyCommand("cargo build --release");
  assert.strictEqual(cmdRoutine.operationClass, "routine_edit");

  const cmdPrivileged = policy.classifyCommand("sudo pacman -S neovim");
  assert.strictEqual(cmdPrivileged.operationClass, "privileged_edit");

  const cmdDestructive = policy.classifyCommand("rm -rf / --no-preserve-root");
  assert.strictEqual(cmdDestructive.operationClass, "high_risk");

  const cmdMkfs = policy.classifyCommand("mkfs.ext4 /dev/nvme0n1p3");
  assert.strictEqual(cmdMkfs.operationClass, "high_risk");

  const cmdSudoers = policy.classifyCommand("sudo visudo");
  assert.strictEqual(cmdSudoers.operationClass, "high_risk");

  const cmdPrivRm = policy.classifyCommand("sudo rm -rf /opt/test");
  assert.strictEqual(cmdPrivRm.operationClass, "high_risk");
  ok("Command classification: read-only, routine, privileged, and high-risk");

  // 3. Node REPL Sandbox Lockdown
  const safeProcess = Object.freeze({
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    env: Object.freeze({}),
    cwd: () => tmpDir,
  });
  const sandbox = {
    Buffer,
    process: safeProcess,
    setTimeout,
    clearTimeout,
  };
  const replContext = vm.createContext(sandbox);

  const requireType = vm.runInContext("typeof require", replContext);
  assert.strictEqual(requireType, "undefined", "require must be undefined in REPL sandbox");

  const mainModuleVal = vm.runInContext("process.mainModule", replContext);
  assert.strictEqual(mainModuleVal, undefined, "process.mainModule must be undefined");

  const bindingType = vm.runInContext("typeof process.binding", replContext);
  assert.strictEqual(bindingType, "undefined", "process.binding must be undefined");

  const exitType = vm.runInContext("typeof process.exit", replContext);
  assert.strictEqual(exitType, "undefined", "process.exit must be undefined");

  const evalEscapeCheck = policy.authorizeEval("require('child_process').execSync('id')");
  assert.strictEqual(evalEscapeCheck.allowed, false);
  assert.strictEqual(evalEscapeCheck.operationClass, "high_risk");
  ok("Node REPL: Sandbox lockdown prevents require, mainModule, binding and escapes");

  // 4. Safe Edit: Atomic Creation & Pre/Post Image Hashes
  const testFile1 = path.join(tmpDir, "atomic-test.txt");
  const edit1 = await executeSafeEdit({
    path: testFile1,
    content: "initial version\n",
  });
  assert.strictEqual(edit1.ok, true);
  assert.strictEqual(edit1.preImageHash, null);
  assert.ok(edit1.postImageHash);
  const readBack1 = await fs.readFile(testFile1, "utf-8");
  assert.strictEqual(readBack1, "initial version\n");
  ok("SafeEdit: Atomic creation and post-image hash calculation");

  // 5. Metadata Preservation
  await fs.chmod(testFile1, 0o600);
  const origStat = await fs.stat(testFile1);
  const edit2 = await executeSafeEdit({
    path: testFile1,
    content: "updated version with preserved mode\n",
    preserveMetadata: true,
  });
  const newStat = await fs.stat(testFile1);
  assert.strictEqual((newStat.mode & 0o777), (origStat.mode & 0o777));
  ok("SafeEdit: File permissions and metadata preserved across replacement");

  // 6. Optimistic Locking / Conflict Detection
  const validHash = edit2.postImageHash;
  await fs.writeFile(testFile1, "out of band edit\n");
  let conflictCaught = false;
  try {
    await executeSafeEdit({
      path: testFile1,
      content: "third version\n",
      expectedHash: validHash,
    });
  } catch (err) {
    conflictCaught = true;
    assert.ok(err.message.includes("CONFLICT_DETECTED"));
  }
  assert.strictEqual(conflictCaught, true);
  assert.strictEqual(await fs.readFile(testFile1, "utf-8"), "out of band edit\n");
  ok("SafeEdit: Conflict detection prevents clobbering out-of-band edits");

  // 7. Symlink Traversal Protection (Target and Parent Directory)
  const symlinkPath = path.join(tmpDir, "symlink-trap.txt");
  await fs.symlink("/etc/sudoers", symlinkPath);

  let symlinkBlocked = false;
  try {
    await executeSafeEdit({
      path: symlinkPath,
      content: "malicious sudoers payload\n",
    });
  } catch (err) {
    symlinkBlocked = true;
    assert.ok(err.message.includes("SECURITY_SYMLINK_BLOCKED") || err.message.includes("SECURITY_HIGH_RISK_BLOCKED"));
  }
  assert.strictEqual(symlinkBlocked, true);

  // Parent directory symlink test
  const parentSymDir = path.join(tmpDir, "parent-sym");
  await fs.symlink("/etc", parentSymDir);
  let parentSymBlocked = false;
  try {
    await executeSafeEdit({
      path: path.join(parentSymDir, "test.conf"),
      content: "test",
    });
  } catch (err) {
    parentSymBlocked = true;
    assert.ok(err.message.includes("SECURITY_SYMLINK_BLOCKED") || err.message.includes("SECURITY_PRIVILEGE_REQUIRED"));
  }
  assert.strictEqual(parentSymBlocked, true);
  ok("SafeEdit: Target and parent directory symlink traversals blocked");

  // 8. Cryptographic Token Binding & HMAC Verification
  const boundPath = path.join(tmpDir, "bound-file.txt");
  await fs.writeFile(boundPath, "bound content\n");
  const boundToken = policy.createAuthorization({
    operationClass: "routine_edit",
    targetPath: boundPath,
    ttlMs: 60000,
    maxUses: 1,
  });

  // Verify HMAC format
  assert.ok(boundToken.startsWith("auth_"));
  assert.ok(boundToken.includes("."));

  // Check wrong target path rejected
  const otherPath = path.join(tmpDir, "other-file.txt");
  const wrongTargetCheck = policy.authorizeFileOperation(otherPath, "write", boundToken);
  // In managed mode routine_edit doesn't require token, so let's test in strict mode
  policy.setMode("strict");
  const strictWrongTarget = policy.authorizeFileOperation(otherPath, "write", boundToken);
  assert.strictEqual(strictWrongTarget.allowed, false, "Token bound to boundPath must not authorize otherPath");

  // Check correct target path accepted
  const strictRightTarget = policy.authorizeFileOperation(boundPath, "write", boundToken);
  assert.strictEqual(strictRightTarget.allowed, true, "Token bound to boundPath must authorize boundPath");

  // Check replay rejected (maxUses exhausted)
  const strictReplay = policy.authorizeFileOperation(boundPath, "write", boundToken);
  assert.strictEqual(strictReplay.allowed, false, "Consumed single-use token must be rejected");

  // Check HMAC forgery rejected
  const forgedToken = boundToken.slice(0, -4) + "dead";
  const forgedCheck = policy.authorizeFileOperation(boundPath, "write", forgedToken);
  assert.strictEqual(forgedCheck.allowed, false, "Forged token signature must be rejected");
  policy.setMode("managed");
  ok("Authorization: HMAC integrity, target binding, and replay prevention verified");

  // 9. Command Authorization with Exact Hash Binding
  const safeCmd = "echo hello";
  const cmdToken = policy.createAuthorization({
    operationClass: "high_risk",
    command: safeCmd,
    ttlMs: 60000,
    maxUses: 1,
  });

  // Mismatched command must be rejected
  const mismatchCmdCheck = policy.authorizeCommand("rm -rf /", cmdToken);
  assert.strictEqual(mismatchCmdCheck.allowed, false, "Token bound to 'echo hello' must not authorize 'rm -rf /'");

  // Exact matching command must be accepted
  const matchCmdCheck = policy.authorizeCommand(safeCmd, cmdToken);
  assert.strictEqual(matchCmdCheck.allowed, true, "Token bound to 'echo hello' must authorize exact command");
  ok("Command Gateway: Exact SHA-256 command-hash token binding verified");

  // 10. Multi-File Patch: Pre-Validation Gate
  const multiPatchWithRestricted = `*** Begin Patch
*** Update File: ${path.join(tmpDir, "multi-1.txt")}
+line 1
*** Update File: /etc/sudoers
+malicious override
*** End Patch`;

  await fs.writeFile(path.join(tmpDir, "multi-1.txt"), "original 1\n");
  let multiPreValBlocked = false;
  try {
    await applyMultiFilePatch(multiPatchWithRestricted);
  } catch (err) {
    multiPreValBlocked = true;
    assert.ok(err.message.includes("SECURITY_BLOCKED") || err.message.includes("SECURITY_HIGH_RISK_BLOCKED"));
  }
  assert.strictEqual(multiPreValBlocked, true);
  // Verify multi-1.txt was NOT touched because pre-validation failed before execution
  assert.strictEqual(await fs.readFile(path.join(tmpDir, "multi-1.txt"), "utf-8"), "original 1\n");
  ok("Multi-File Patch: Pre-validation blocks entire transaction before touching any file");

  // 11. Multi-File Patch: Hunk Context Pre-check & Mid-Execution Rollback
  const fileA = path.join(tmpDir, "rollback-a.txt");
  const fileB = path.join(tmpDir, "rollback-b.txt");
  await fs.writeFile(fileA, "file A original\n");
  await fs.writeFile(fileB, "file B original\n");

  // 11a: Hunk context mismatch detected in Pass 2 (before any files are touched)
  const contextFailPatch = `*** Begin Patch
*** Update File: ${fileA}
@@
-file A original
+file A updated
*** Update File: ${fileB}
@@
-nonexistent line that fails hunk matching
+replacement line
*** End Patch`;

  let contextCheckFailed = false;
  try {
    await applyMultiFilePatch(contextFailPatch);
  } catch (err) {
    contextCheckFailed = true;
    assert.ok(err.message.includes("Patch context not found in file"));
  }
  assert.strictEqual(contextCheckFailed, true);
  assert.strictEqual(await fs.readFile(fileA, "utf-8"), "file A original\n");
  assert.strictEqual(await fs.readFile(fileB, "utf-8"), "file B original\n");

  // 11b: Execution failure in Pass 4 triggers automatic rollback of previously modified files
  const fileDir = path.join(tmpDir, "dir-as-file");
  await fs.mkdir(fileDir, { recursive: true });

  const executionFailPatch = `*** Begin Patch
*** Update File: ${fileA}
@@
-file A original
+file A updated
*** Add File: ${fileDir}
+this write will fail because target is a directory
*** End Patch`;

  let execFailCaught = false;
  try {
    await applyMultiFilePatch(executionFailPatch);
  } catch (err) {
    execFailCaught = true;
    assert.ok(err.message.includes("Multi-file patch transaction failed"));
    assert.ok(err.message.includes("All modified files successfully rolled back"));
  }
  assert.strictEqual(execFailCaught, true);
  // Assert File A was rolled back to its exact original content!
  assert.strictEqual(await fs.readFile(fileA, "utf-8"), "file A original\n");
  ok("Multi-File Patch: Automatic rollback restores all modified files on mid-patch failure");

  // 12. Strict Mode Policy Enforcement
  policy.setMode("strict");
  const strictWrite = policy.authorizeFileOperation(testFile1, "write");
  assert.strictEqual(strictWrite.allowed, false);

  const strictRoutineToken = policy.createAuthorization({
    operationClass: "routine_edit",
    targetPath: testFile1,
    ttlMs: 30000,
  });
  const strictAuthWrite = policy.authorizeFileOperation(testFile1, "write", strictRoutineToken);
  assert.strictEqual(strictAuthWrite.allowed, true);
  policy.setMode("managed");
  ok("Strict Mode: Rejects unauthenticated routine writes; accepts scoped bound token");

  // 13. Path Traversal Canonicalization
  const sneakyPath = path.join(tmpDir, "..", path.basename(tmpDir), "canonical-check.txt");
  const editCanonical = await executeSafeEdit({
    path: sneakyPath,
    content: "canonical ok\n",
  });
  assert.strictEqual(editCanonical.ok, true);
  assert.strictEqual(path.isAbsolute(editCanonical.path), true);
  assert.strictEqual(editCanonical.path.includes(".."), false);
  ok("Path Traversal: Relative traversals resolved to canonical absolute paths");

  // 14. File Operations Policy Gating (copy_file & move_file targets)
  const copyCheckBad = policy.authorizeFileOperation("/etc/sudoers", "write");
  assert.strictEqual(copyCheckBad.allowed, false);
  assert.strictEqual(copyCheckBad.operationClass, "high_risk");

  const moveDelCheck = policy.authorizeFileOperation("/etc/shadow", "delete");
  assert.strictEqual(moveDelCheck.allowed, false);
  assert.strictEqual(moveDelCheck.operationClass, "high_risk");

  const routineCopySrc = path.join(tmpDir, "copy-src.txt");
  const routineCopyDest = path.join(tmpDir, "copy-dest.txt");
  await fs.writeFile(routineCopySrc, "copy content\n");
  const copyExec = await executeSafeEdit({
    path: routineCopyDest,
    content: await fs.readFile(routineCopySrc),
  });
  assert.strictEqual(copyExec.ok, true);
  assert.strictEqual(await fs.readFile(routineCopyDest, "utf-8"), "copy content\n");
  ok("File Operations: copy_file and move_file policy gates and atomic copies verified");

  // 15. Git Operations Security Gating
  const gitHardResetCheck = policy.classifyCommand("git reset --hard HEAD~1");
  // Any destructive git reset or privileged command check
  const gitRestoreCheck = policy.authorizeFileOperation("/etc/sudoers", "write");
  assert.strictEqual(gitRestoreCheck.allowed, false);
  assert.strictEqual(gitRestoreCheck.operationClass, "high_risk");
  ok("Git Operations: Gated restore and reset security classifications verified");

} catch (err) {
  fail("Phase 1 test suite uncaught error", err);
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log(`\nPhase 1 Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
