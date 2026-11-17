// Pure filesystem and transaction tests. Real systemd is deliberately never called.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { fixturePorts } from "./test-ports.mjs";
import { gzipSync, gunzipSync } from "node:zlib";

// The release controller must refuse dangerous-mode acceptance before cutover.
// This is a structural regression; live negative acceptance is tested separately.
const managerSource = await fs.readFile("src/lib/service-manager.ts", "utf8");
assert.equal((managerSource.match(/await requireStandardServiceMode\(/g) || []).length, 3);
assert.match(managerSource, /SERVICE_UPDATE_REQUIRES_STANDARD/);
assert.match(managerSource, /response\.status === 401[\s\S]*SERVICE_ADMIN_CREDENTIAL_DRIFT/);
assert.match(managerSource, /error\.message\.startsWith\("SERVICE_ADMIN_CREDENTIAL_DRIFT"\)/);
if (!process.env.BRIDGEDEV_TEST_ROOT) throw Error("Use isolated-tests.mjs");
const base = path.join(process.env.BRIDGEDEV_TEST_ROOT, "service-test");
await fs.mkdir(base);
const config = await import("../dist/lib/service-config.js");
const release = await import("../dist/lib/service-release.js");
if (process.platform !== "linux") {
  assert.equal((await config.serviceStatus()).supported, false);
  const { installService } = await import("../dist/lib/service-manager.js");
  await assert.rejects(installService({}), /SERVICE_UNSUPPORTED/);
  console.log(
    "Service: non-Linux unsupported result verified; native systemd tests require Linux",
  );
  process.exit(0);
}
const src = path.join(base, "source");
for (const name of [
  "dist",
  "public",
  "profiles",
  "scripts",
  "src",
  "docs",
  "node_modules",
])
  await fs.mkdir(path.join(src, name), { recursive: true });
for (const [name, value] of Object.entries({
  "dist/index.js": "process.exit(0);",
  "dist/cli.js": 'console.log("fixture");',
  "package.json": '{"type":"module"}',
  "pnpm-lock.yaml": "lockfileVersion: 9",
  LICENSE: "MIT",
  "README.md": "fixture",
}))
  await fs.writeFile(path.join(src, name), value);
const a = "a".repeat(40),
  b = "b".repeat(40),
  root = path.join(base, "install");
let artifact = await release.createReleaseBundle(src, a);
const installed = await release.stageBundle(artifact, root, a, {
  verified_ci: true,
});
assert.equal((await release.verifyRelease(installed)).commit, a);
assert.equal(await release.stageBundle(artifact, root, a, {}), installed);
const verifiedStagedRelease=release.verifiedStagedRelease;
const verifiedRoot=path.join(base,"preverified-artifact");
const verifiedDir=await release.stageBundle(artifact,verifiedRoot,a,{
  repository:"kmanisk/bridge-dev",verified_ci:true,workflow_run:42,
  artifact_digest:"sha256:"+"a".repeat(64),artifact_id:99,
});
assert.deepEqual(await verifiedStagedRelease(a,verifiedRoot),{
  commit:a,release:verifiedDir
},"A valid pre-staged artifact needs no second gh invocation");
assert.equal(await verifiedStagedRelease(b,verifiedRoot),null);
const unverified=path.join(base,"unverified-artifact");
await release.stageBundle(artifact,unverified,a,{verified_ci:false});
await assert.rejects(verifiedStagedRelease(a,unverified),/SERVICE_STAGED_PROVENANCE_INVALID/);

await fs.chmod(path.join(installed, "dist/index.js"), 0o644);
await assert.rejects(release.verifyRelease(installed), /RELEASE_MODE_CHANGED/);
await fs.chmod(path.join(installed, "dist/index.js"), 0o444);
await fs.writeFile(path.join(installed, "unexpected"), "unreviewed");
await assert.rejects(release.verifyRelease(installed), /RELEASE_UNMANIFESTED/);
await fs.rm(path.join(installed, "unexpected"));
const decode = () => JSON.parse(gunzipSync(artifact));
for (const mutate of [
  (v) => (v.version = 99),
  (v) => (v.files[0].path = "../escape"),
  (v) => (v.files[0].sha256 = "0".repeat(64)),
  (v) => v.files.push(v.files[0]),
  (v) =>
    v.files.push({
      path: "escape",
      mode: 292,
      sha256: "0".repeat(64),
      link: "../../outside",
    }),
]) {
  const value = decode();
  mutate(value);
  await assert.rejects(
    release.stageBundle(
      gzipSync(JSON.stringify(value)),
      path.join(base, "bad-" + Math.random()),
      a,
      {},
    ),
  );
}
const runs = ["policy-tests", "portable-platforms", "linux-distributions"].map(
  (name, i) => ({
    name,
    id: i,
    head_sha: a,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
  }),
);
release.verifyCiEvidence(runs, a);
assert.throws(
  () =>
    release.verifyCiEvidence(
      runs.map((r) => ({ ...r, head_sha: b })),
      a,
    ),
  /CI_NOT_GREEN/,
);
assert.throws(
  () =>
    release.verifyCiEvidence(
      [...runs, { ...runs[0], id: 90, conclusion: "failure" }],
      a,
    ),
  /CI_NOT_GREEN/,
);
const envFile = path.join(base, "environment"),
  workspace = path.join(base, "workspace"),
  state = path.join(base, "state");
await fs.mkdir(workspace);
const [mcpPort, adminPort] = await fixturePorts(2);
await fs.writeFile(
  envFile,
  `BRIDGEDEV_RUNTIME_MODE=portable\nMCP_TOKEN=${"a".repeat(64)}\nADMIN_TOKEN=${"b".repeat(64)}\nWORKSPACE_PATH=${workspace}\nBRIDGEDEV_STATE_DIR=${state}\nPORT=${mcpPort}\nADMIN_PORT=${adminPort}\n`,
  { mode: 0o600 },
);
const c = await config.makeServiceConfig({
  root,
  envFile,
  unit: "bridge-dev-fixture.service",
  sourceCommit: a,
});
const unit = config.renderUnit({ ...c, sandbox: "full" });
assert.ok(
  unit.includes("WorkingDirectory=" + c.working_directory + "\n"),
  "WorkingDirectory uses an absolute unquoted single-path directive",
);
assert.ok(
  unit.includes("EnvironmentFile=" + c.env_file + "\n"),
  "EnvironmentFile is a single unquoted absolute path",
);
for (const directive of [
  "Restart=on-failure",
  "RestartSec=3s",
  "StartLimitBurst=4",
  "KillMode=control-group",
  "NoNewPrivileges=yes",
  "UMask=0077",
  "PrivateTmp=yes",
  "ProtectHome=read-only",
  "ProtectSystem=strict",
  "MemoryMax=1024M",
  "TasksMax=256",
  "EnvironmentFile=",
])
  assert.ok(unit.includes(directive), directive);
for (const forbidden of [
  "MemoryDenyWriteExecute",
  "MCP_TOKEN=",
  "ADMIN_TOKEN=",
  "/bin/sh",
  "/bin/bash",
])
  assert.ok(!unit.includes(forbidden));
assert.throws(() => config.systemdQuote("x\ny"), /CONTROL_CHARACTER/);
await fs.chmod(envFile, 0o644);
assert.throws(() => config.privateEnvironment(envFile), /0600/);
await fs.chmod(envFile, 0o600);
await config.writeServiceConfig(c);
assert.deepEqual(await config.readServiceConfig(root), c);
await fs.writeFile(
  config.configFile(root),
  JSON.stringify({ ...c, version: 99 }),
);
await assert.rejects(config.readServiceConfig(root), /FUTURE_SCHEMA/);
await config.writeServiceConfig(c);
// Emulate systemd only at its command boundary; install/pointer/locking remain real.
const calls = [];
let active = false;
mock.module("../dist/lib/service-config.js", {
  namedExports: {
    ...config,
    systemctl: async (args) => {
      calls.push(args);
      if (args[0] === "start") active = true;
      if (args[0] === "stop") active = false;
      return "";
    },
    serviceStatus: async () => ({
      supported: true,
      installed: true,
      active,
      linger: true,
      current: (await config.readServiceConfig(root)).current,
    }),
  },
});
mock.module("node:child_process", {
  namedExports: {
    spawn: (cmd, args, opts) => {
      if (cmd !== "systemd-run") return realSpawn(cmd, args, opts);
      calls.push([cmd, ...args]);
      const event = new EventEmitter();
      queueMicrotask(() => event.emit("close", 0));
      return event;
    },
  },
});
const manager = await import("../dist/lib/service-manager.js");
await manager.installService({ root, envFile, enable: false });
await manager.installService({ root, envFile, enable: false });
assert.ok(calls.some((c) => c[0] === "daemon-reload"));
assert.equal(
  await fs.readlink(path.join(root, "current")),
  path.join("releases", a),
);
await release.stageBundle(await release.createReleaseBundle(src, b), root, b, {
  verified_ci: true,
});
const job = await manager.queueServiceOperation("update", b, root);
assert.equal(
  (await manager.queueServiceOperation("update", b, root)).job_id,
  job.job_id,
);
assert.ok(
  calls.some(
    (c) =>
      c[0] === "systemd-run" &&
      c.includes("--collect") &&
      c.some((v) => v.startsWith("--property=ExecStopPost=")),
  ),
);
await manager.rollbackServiceJob(
  root,
  job.job_id,
  "synthetic preflight failure",
);
assert.equal((await manager.jobResult(root, job.job_id)).status, "FAILED");
assert.equal((await config.readServiceConfig(root)).current, a);
assert.equal(
  await fs.readlink(path.join(root, "current")),
  path.join("releases", a),
);
assert.ok(
  !calls.some((c) => c[0] === "stop"),
  "Failed preflight must leave running service untouched",
);
await manager.controlService("start", root);
assert.equal(active, true);
await manager.controlService("stop", root);
assert.equal(active, false);
// A pre-service runtime must not receive an unsupported audit API call.
const manifestFile = path.join(root, "releases", a, "RELEASE_MANIFEST.json"),
  legacyManifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
legacyManifest.evidence = { operator_bootstrap: true };
await fs.writeFile(manifestFile, JSON.stringify(legacyManifest));
const { HashAudit, verifyAuditFile } =
  await import("../dist/lib/hash-audit.js");
await new HashAudit(c.audit_file).append({ phase: "fixture_baseline" });
const prefix = await fs.readFile(c.audit_file),
  auditInode = (await fs.stat(c.audit_file)).ino;
const originalFetch = globalThis.fetch;
let posts = 0;
globalThis.fetch = async (_url, options) => {
  if (options?.method === "POST") {
    posts++;
    throw Error("Old runtime has no service audit endpoint");
  }
  return new Response(
    JSON.stringify({ status: "ok", commit: a, full_machine_access: false }),
  );
};
active = true;
try {
  assert.match(
    await manager.completeServiceAudit(c, {
      operation: "rollback",
      job: "fixture",
      from: b,
      to: a,
      outcome: "success",
    }),
    /legacy offline/,
  );
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(posts, 0);
assert.equal(active, true);
assert.equal((await fs.stat(c.audit_file)).ino, auditInode);
assert.ok(
  (await fs.readFile(c.audit_file)).subarray(0, prefix.length).equals(prefix),
);
assert.equal(verifyAuditFile(c.audit_file).entries, 2);
assert.match(
  await fs.readFile(c.audit_file, "utf8"),
  /accepted_before_legacy_restart/,
);
// Ordinary start has no exposure effect; an explicit callback follows readiness.
const exposureEvents = [];
const fetchBeforeStart = globalThis.fetch;
globalThis.fetch = async () => {
  exposureEvents.push("health");
  return new Response(
    JSON.stringify({ status: "ok", commit: a, full_machine_access: false }),
  );
};
try {
  await manager.startConfiguredService(root, (port) => {
    assert.equal(port, c.port);
    assert.ok(exposureEvents.length > 0);
    exposureEvents.push("expose");
  });
  assert.equal(exposureEvents.at(-1), "expose");
  exposureEvents.length = 0;
  await manager.startConfiguredService(root);
  assert.deepEqual(exposureEvents, []);
} finally {
  globalThis.fetch = fetchBeforeStart;
}
await manager.controlService("uninstall", root);
await manager.controlService("uninstall", root);
assert.equal(
  (await fs.stat(path.join(root, "releases", a))).isDirectory(),
  true,
);
console.log(
  "Service PASS: unit hardening, credential source permissions, strict config, release hashes/modes/path attacks, exact-SHA CI gates, idempotent install/uninstall, atomic pointer, exclusive tracked job and preflight failure containment. Real systemd staging is a separate deployment gate.",
);
// Versioned writable settings never rewrite the environment credential source.
const { safeEnvironment, saveSafeEnvironment } =
  await import("../dist/lib/safe-environment.js");
const { settingsPath } = await import("../dist/lib/runtime-settings.js");
const { readPortableMode } = await import("../dist/lib/portable-mode.js");
const { portableStateDir } = await import("../dist/lib/runtime.js");
const envDigest = createHash("sha256")
  .update(await fs.readFile(envFile))
  .digest("hex");
saveSafeEnvironment({ SHELL_TIMEOUT: "30" });
assert.equal(safeEnvironment().SHELL_TIMEOUT, "30");
assert.throws(() => saveSafeEnvironment({ MCP_TOKEN: "not allowed" }));
assert.throws(() => saveSafeEnvironment({ SHELL_TIMEOUT: "3601" }));
saveSafeEnvironment({ SHELL_TIMEOUT: "31" });
assert.ok(
  (await fs.readdir(path.dirname(settingsPath("environment")))).some((n) =>
    n.includes("backup-"),
  ),
);
await fs.writeFile(
  settingsPath("environment"),
  JSON.stringify({ version: 99, data: {} }),
);
assert.throws(safeEnvironment, /FUTURE_SCHEMA/);
assert.equal(
  createHash("sha256")
    .update(await fs.readFile(envFile))
    .digest("hex"),
  envDigest,
);
await fs.mkdir(portableStateDir(), { recursive: true });
const modeFile = path.join(portableStateDir(), "mode.json");
await fs.writeFile(modeFile, JSON.stringify({ mode: "strict" }));
assert.equal(readPortableMode(), "strict");
await fs.writeFile(modeFile, JSON.stringify({ version: 1, mode: "standard" }));
assert.equal(readPortableMode(), "standard");
await fs.writeFile(modeFile, JSON.stringify({ version: 99, mode: "standard" }));
assert.throws(readPortableMode, /FUTURE_SCHEMA/);
console.log(
  "Settings PASS: strict versions, validated safe keys, atomic backups, credential-source hash unchanged, legacy and versioned mode with future-schema refusal",
);
