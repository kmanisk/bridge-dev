import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { atomicJson } from "./atomic-store.js";
import {runShadowAcceptance} from "./shadow-update.js";
import {snapshotUpdateLease,assertSameUpdateLease,assertLocalUpdateCgroup,type UpdateLeaseSnapshot} from "./update-lease.js";
import { HashAudit, verifyAuditFile } from "./hash-audit.js";
import {
  readServiceConfig,
  writeServiceConfig,
  renderUnit,
  makeServiceConfig,
  serviceStatus,
  serviceRoot,
  sourceRoot,
  privateEnvironment,
  systemctl,
  operatorEnvironment,
  systemdQuote,
  type ServiceConfig,
} from "./service-config.js";
import {
  seedLocalRelease,
  stageVerifiedGithubRelease,
  verifyRelease,
} from "./service-release.js";
const hash = (v: Buffer | string) =>
  createHash("sha256").update(v).digest("hex");
const jobPattern = /^[a-f0-9-]{36}$/;
interface ServiceJob {
  version: 1;
  id: string;
  root: string;
  unit: string;
  operation: "update" | "rollback" | "adopt";
  target: string;
  before: ServiceConfig;
  transient?: { unit: string; app: string; node: string; cwd: string };
  created_at: string;
  env_hash: string;
  browser?: string;
  crash_test?: boolean;
  audit_prefix?: { bytes: number; digest: string; inode: number; mode: number };
  shadow_lease?: UpdateLeaseSnapshot;
}
interface JobResult {
  version: 1;
  id: string;
  status:
    | "PENDING"
    | "VERIFYING"
    | "STOPPING"
    | "SWITCHED"
    | "SUCCESS"
    | "ROLLED_BACK"
    | "FAILED";
  exit_code: number | null;
  time: string;
  error?: string;
  pid?: number;
  commit?: string;
  acceptance?: unknown;
}
export function jobDirectory(root: string, id: string): string {
  if (!jobPattern.test(id)) throw Error("SERVICE_JOB_ID_INVALID");
  return path.join(root, "service/jobs", id);
}
export async function jobResult(root: string, id: string): Promise<JobResult> {
  const value = JSON.parse(
    await fs.readFile(path.join(jobDirectory(root, id), "result.json"), "utf8"),
  );
  if (
    value.version !== 1 ||
    value.id !== id ||
    ![
      "PENDING",
      "VERIFYING",
      "STOPPING",
      "SWITCHED",
      "SUCCESS",
      "ROLLED_BACK",
      "FAILED",
    ].includes(value.status)
  )
    throw Error("SERVICE_JOB_FUTURE_OR_INVALID");
  return value;
}
async function record(
  job: ServiceJob,
  values: Partial<JobResult>,
): Promise<JobResult> {
  let old: Partial<JobResult> = {};
  try {
    old = await jobResult(job.root, job.id);
  } catch {}
  const next = {
    version: 1 as const,
    id: job.id,
    status: "PENDING" as const,
    exit_code: null,
    ...old,
    ...values,
    time: new Date().toISOString(),
  };
  await atomicJson(
    path.join(jobDirectory(job.root, job.id), "result.json"),
    next,
  );
  return next;
}
export async function pointCurrent(
  root: string,
  commit: string,
  name = "current",
): Promise<void> {
  await verifyRelease(path.join(root, "releases", commit), commit);
  const temp = path.join(root, ".current-" + randomUUID());
  await fs.symlink(path.join("releases", commit), temp);
  try {
    await fs.rename(temp, path.join(root, name));
    const directory = await fs.open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function installService(options: {
  root?: string;
  envFile?: string;
  unit?: string;
  sandbox?: "full" | "basic";
  source?: string;
  enable?: boolean;
  start?: boolean;
  memory?: number;
  tasks?: number;
}): Promise<Record<string, unknown>> {
  if (process.platform !== "linux")
    throw Error("SERVICE_UNSUPPORTED: Linux systemd user manager required");
  const root = path.resolve(options.root || serviceRoot()),
    existing = await readServiceConfig(root);
  const seeded = existing
    ? { commit: existing.current }
    : await seedLocalRelease(root, options.source || sourceRoot);
  const c =
    existing ||
    (await makeServiceConfig({
      ...options,
      root,
      sourceCommit: seeded.commit,
    }));
  if (
    existing &&
    options.envFile &&
    path.resolve(options.envFile) !== c.env_file
  )
    throw Error(
      "SERVICE_CONFIG_EXISTS: explicit environment changes require operator review",
    );
  const old = await fs
    .readFile(c.unit_file, "utf8")
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return "";
    });
  if (old && !old.startsWith("# BridgeDev generated user service; schema 1."))
    throw Error("SERVICE_UNIT_NOT_OWNED: refusing to overwrite");
  await fs.mkdir(path.dirname(c.unit_file), { recursive: true, mode: 0o700 });
  const unit = renderUnit(c);
  if (old !== unit) {
    const temp = c.unit_file + "." + randomUUID();
    await fs.writeFile(temp, unit, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, c.unit_file);
  }
  if (!sync.existsSync(path.join(root, "current")))
    await pointCurrent(root, c.current);
  await writeServiceConfig(c);
  await systemctl(["daemon-reload"]);
  if (options.enable !== false) await systemctl(["enable", c.unit]);
  if (options.start) await controlService("start", root);
  const status = await serviceStatus(root);
  return {
    ...status,
    linger_command: status.linger
      ? null
      : "sudo loginctl enable-linger " + os.userInfo().username,
    funnel: "unchanged",
    credentials: "existing protected EnvironmentFile; never copied into unit",
  };
}
export async function controlService(
  action: "start" | "stop" | "restart" | "enable" | "disable" | "uninstall",
  root = serviceRoot(),
): Promise<Record<string, any>> {
  if (process.platform !== "linux")
    throw Error("SERVICE_UNSUPPORTED: Linux systemd user manager required");
  const c = await readServiceConfig(root);
  if (!c) {
    if (action === "uninstall")
      return { installed: false, already_absent: true };
    throw Error("SERVICE_NOT_INSTALLED");
  }
  if (["start", "restart"].includes(action)) {
    await verifyRelease(path.join(root, "releases", c.current), c.current);
    if (action === "start" && (await serviceStatus(root)).active)
      return serviceStatus(root);
  }
  if (action === "uninstall") {
    const unit = await fs.readFile(c.unit_file, "utf8").catch(() => "");
    if (
      unit &&
      !unit.startsWith("# BridgeDev generated user service; schema 1.")
    )
      throw Error("SERVICE_UNIT_NOT_OWNED");
    await systemctl(["disable", "--now", c.unit], false);
    await fs.rm(c.unit_file, { force: true });
    await systemctl(["daemon-reload"]);
    return {
      installed: false,
      releases_preserved: true,
      credentials_preserved: true,
      linger: "unchanged",
    };
  }
  await systemctl([action, c.unit]);
  return serviceStatus(root);
}
/** Existing explicit CLI exposure remains opt-in and follows authenticated readiness. */
export async function startConfiguredService(
  root = serviceRoot(),
  expose?: (port: number) => unknown,
): Promise<Record<string, any>> {
  const status = await controlService("start", root);
  if (expose) {
    const config = await readServiceConfig(root);
    if (!config) throw Error("SERVICE_NOT_INSTALLED");
    await checkGateway(config, false);
    await expose(config.port);
  }
  return status;
}
async function authHealth(c: ServiceConfig): Promise<any> {
  const env = privateEnvironment(c.env_file);
  const response = await fetch(`http://127.0.0.1:${c.admin_port}/health`, {
    headers: { Authorization: "Bearer " + env.ADMIN_TOKEN },
    signal: AbortSignal.timeout(3000),
  });
  if (response.status === 401)
    throw Error("SERVICE_ADMIN_CREDENTIAL_DRIFT: running Admin endpoint rejected the protected configuration token; reconcile credentials locally before restarting");
  if (!response.ok) throw Error("SERVICE_ADMIN_HEALTH_FAILED");
  return response.json();
}

/** Release acceptance tests deny privileged and destructive commands. Never run
 * them against an operator-authorized Full System gateway. Fail before cutover,
 * and repeat the check after staging in case the operator changed modes. */
async function requireStandardServiceMode(c: ServiceConfig): Promise<void> {
  let health: any;
  try {
    health = await authHealth(c);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SERVICE_ADMIN_CREDENTIAL_DRIFT"))
      throw error;
    throw Error("SERVICE_UPDATE_REQUIRES_HEALTHY_STANDARD_GATEWAY");
  }
  const isDangerous = health.full_machine_access === true || health.full_disk_access === true || health.security_mode === "dangerous" || health.security_mode === "yolo";
  if (health.status !== "ok" || isDangerous)
    throw Error("SERVICE_UPDATE_REQUIRES_STANDARD: active Full System (YOLO) must be independently revoked by the local operator before release acceptance");
}
async function healthy(
  c: ServiceConfig,
  commit?: string,
  timeout = 20000,
  expectedFullMachineAccess = false,
): Promise<any> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const h = await authHealth(c);
      if (
        h.status === "ok" &&
        (!commit || h.commit === commit) &&
        h.full_machine_access === expectedFullMachineAccess
      )
        return h;
      // Only the explicitly operator-seeded rollback release predates commit health.
      // A CI update must always report its exact commit and verified safe mode.
      if (commit && h.status === "ok" && !h.commit) {
        const manifest = await verifyRelease(
          path.join(c.root, "releases", commit),
          commit,
        );
        if (manifest.evidence.operator_bootstrap === true) {
          const status = await serviceStatus(c.root),
            env = privateEnvironment(c.env_file);
          const response = await fetch(`http://127.0.0.1:${c.port}/health`, {
            headers: { Authorization: "Bearer " + env.MCP_TOKEN },
            signal: AbortSignal.timeout(2000),
          });
          const detail = (await response.json()) as any;
          if (
            status.active &&
            status.pointer_consistent &&
            h.pid === status.pid &&
            response.ok &&
            detail.runtimeMode === "portable" &&
            detail.fullMachineAccess === expectedFullMachineAccess
          )
            return h;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error("SERVICE_HEALTH_TIMEOUT");
}
async function assertPortsClosed(c: ServiceConfig): Promise<void> {
  for (const port of [c.port, c.admin_port]) {
    const socket = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(port, "127.0.0.1", resolve);
      });
    } catch {
      throw Error("SERVICE_AUDIT_OWNER_STILL_LISTENING");
    } finally {
      if (socket.listening)
        await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  }
}
async function auditOffline(
  c: ServiceConfig,
  event: Record<string, unknown>,
): Promise<void> {
  const status = await serviceStatus(c.root);
  if (status.active) throw Error("SERVICE_AUDIT_OWNER_STILL_ACTIVE");
  await assertPortsClosed(c);
  await new HashAudit(c.audit_file).append({
    phase: "service_operation",
    actor: "operator-cli",
    ...event,
  });
}
async function auditEvent(
  c: ServiceConfig,
  event: Record<string, unknown>,
): Promise<void> {
  const env = privateEnvironment(c.env_file),
    r = await fetch(`http://127.0.0.1:${c.admin_port}/api/service/events`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
  if (!r.ok) throw Error("SERVICE_AUDIT_EVENT_FAILED");
}
/** Pre-service rollback runtimes have no operator receipt API. Never create a
 * concurrent ledger writer: stop, record the passed acceptance, then restart and
 * verify the same immutable release. The final job receipt follows health. */
export async function completeServiceAudit(
  c: ServiceConfig,
  event: Record<string, unknown>,
): Promise<string> {
  const manifest = await verifyRelease(
    path.join(c.root, "releases", c.current),
    c.current,
  );
  if (
    manifest.evidence.operator_bootstrap === true &&
    !manifest.files.some((file) => file.path === "dist/service-worker.js")
  ) {
    await systemctl(["stop", c.unit]);
    await auditOffline(c, {
      ...event,
      outcome: "accepted_before_legacy_restart",
    });
    await systemctl(["reset-failed", c.unit], false);
    await systemctl(["start", c.unit]);
    await healthy(c, c.current);
    return "legacy offline handoff; final restart health verified";
  }
  await auditEvent(c, event);
  return "authenticated gateway receipt";
}
export async function checkGateway(
  c: ServiceConfig,
  allReads = true,
): Promise<any> {
  const env = privateEnvironment(c.env_file);
  await healthy(c, c.current);
  if (allReads) {
    const { acceptPortableGateway } = await import(
      pathToFileURL(
        path.join(sourceRoot, "scripts/deploy-acceptance/portable-client.mjs"),
      ).href
    );
    return acceptPortableGateway({
      url: `http://127.0.0.1:${c.port}/mcp`,
      adminUrl: `http://127.0.0.1:${c.admin_port}`,
      mcpToken: env.MCP_TOKEN,
      adminToken: env.ADMIN_TOKEN,
      workspace: c.workspace[0],
      inventory: JSON.parse(
        await fs.readFile(
          path.join(
            c.root,
            "releases",
            c.current,
            "profiles/native-tool-counts.json",
          ),
          "utf8",
        ),
      ).tools.slim,
    });
  }
  return healthy(c, c.current);
}
/** Positive-only checks for a live gateway whose signed YOLO lease must stay
 * untouched. The negative suite runs exclusively in the namespace sandbox. */
export async function checkLeasedGateway(c:ServiceConfig):Promise<any>{
  const env=privateEnvironment(c.env_file);
  await healthy(c,c.current,20000,true);
  const {positiveGatewaySmoke}=await import(
    pathToFileURL(path.join(sourceRoot,"scripts/deploy-acceptance/positive-client.mjs")).href);
  return positiveGatewaySmoke({
    url:`http://127.0.0.1:${c.port}/mcp`,
    adminUrl:`http://127.0.0.1:${c.admin_port}`,
    mcpToken:env.MCP_TOKEN,
    adminToken:env.ADMIN_TOKEN,
    expectedFullMachineAccess:true,
    inventory:JSON.parse(await fs.readFile(
      path.join(c.root,"releases",c.current,"profiles/native-tool-counts.json"),"utf8")).tools.slim,
  });
}
async function freePorts(): Promise<[number, number]> {
  const sockets: net.Server[] = [];
  try {
    const ports = [];
    for (let i = 0; i < 2; i++) {
      const s = net.createServer();
      sockets.push(s);
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(0, "127.0.0.1", resolve);
      });
      ports.push((s.address() as net.AddressInfo).port);
    }
    return ports as [number, number];
  } finally {
    await Promise.all(
      sockets.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  }
}
export async function probeRelease(
  release: string,
  parent: string,
): Promise<void> {
  const metadata = await verifyRelease(release);
  const root = await fs.mkdtemp(path.join(parent, ".probe-")),
    workspace = path.join(root, "workspace"),
    [port, admin] = await freePorts();
  await fs.mkdir(workspace);
  const token =
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    adminToken =
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    BRIDGEDEV_TEST_ROOT: root,
    DOTENV_CONFIG_PATH: path.join(root, "absent.env"),
    BRIDGEDEV_RUNTIME_MODE: "portable",
    BRIDGEDEV_STATE_DIR: path.join(root, "state"),
    WORKSPACE_PATH: workspace,
    MCP_UPSTREAM_CONFIG: path.join(root, "providers.json"),
    MCP_SHELL_STATE_DIR: path.join(root, "shell"),
    CHECKPOINT_ENABLED: "false",
    PORT: String(port),
    ADMIN_PORT: String(admin),
    MCP_TOKEN: token,
    ADMIN_TOKEN: adminToken,
  };
  const child = spawn(process.execPath, [path.join(release, "dist/index.js")], {
    cwd: root,
    env,
    stdio: "ignore",
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw Error("SERVICE_PREFLIGHT_START_FAILED");
      try {
        if (
          (
            await fetch(
              `http://127.0.0.1:${port}/${metadata.evidence.operator_bootstrap === true ? "health" : "healthz"}`,
              {
                headers: { Authorization: "Bearer " + token },
                signal: AbortSignal.timeout(500),
              },
            )
          ).ok
        ) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw Error("SERVICE_PREFLIGHT_TIMEOUT");
    const { acceptPortableGateway } = await import(
      pathToFileURL(
        path.join(sourceRoot, "scripts/deploy-acceptance/portable-client.mjs"),
      ).href
    );
    await acceptPortableGateway({
      url: `http://127.0.0.1:${port}/mcp`,
      adminUrl: `http://127.0.0.1:${admin}`,
      mcpToken: token,
      adminToken,
      workspace,
      inventory: JSON.parse(
        await fs.readFile(
          path.join(release, "profiles/native-tool-counts.json"),
          "utf8",
        ),
      ).tools.slim,
    });
  } finally {
    if (child.exitCode === null) {
      await fetch(`http://127.0.0.1:${admin}/api/lifecycle/stop`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + adminToken,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(2000),
      }).catch(() => child.kill("SIGTERM"));
      await Promise.race([closed, new Promise((r) => setTimeout(r, 4000))]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function lockOwner(
  root: string,
): Promise<{ job: string; token: string } | null> {
  try {
    return JSON.parse(
      await fs.readFile(
        path.join(root, "service/update.lock/owner.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}
export async function queueServiceOperation(
  operation: "update" | "rollback" | "adopt",
  target: string,
  root = serviceRoot(),
  transient?: ServiceJob["transient"],
  options?:{shadowLease:UpdateLeaseSnapshot},
): Promise<Record<string, unknown>> {
  if(options?.shadowLease){
    if(operation!=="update"||!process.stdin.isTTY||!process.stdout.isTTY||process.getuid?.()===0)
      throw Error("UPDATE_SHADOW_LOCAL_OPERATOR_TTY_REQUIRED");
    try{assertLocalUpdateCgroup(sync.readFileSync("/proc/self/cgroup","utf8"));}
    catch(error){if((error as Error).message.startsWith("UPDATE_"))throw error;
      throw Error("UPDATE_LOCAL_SESSION_UNVERIFIED");}
    assertSameUpdateLease(options.shadowLease,snapshotUpdateLease());
    if(options.shadowLease.mode!=="YOLO")throw Error("UPDATE_SHADOW_REQUIRES_SIGNED_YOLO");
  }
  const c = await readServiceConfig(root);
  if (!c) throw Error("SERVICE_NOT_INSTALLED");
  await verifyRelease(path.join(root, "releases", target), target);
  const lock = path.join(root, "service/update.lock");
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await lockOwner(root);
    if (owner) {
      const r = await jobResult(root, owner.job);
      return {
        job_id: owner.job,
        unit: "bridge-dev-update-" + owner.job + ".service",
        status: r.status,
        existing_job: true,
        note: "Inspect this recorded job before submitting another update",
      };
    }
    throw Error(
      "SERVICE_UPDATE_BUSY: unknown lock owner; inspect before recovery",
    );
  }
  const id = randomUUID(),
    job: ServiceJob = {
      version: 1,
      id,
      root,
      unit: "bridge-dev-update-" + id + ".service",
      operation,
      target,
      before: c,
      transient,
      created_at: new Date().toISOString(),
      env_hash: hash(await fs.readFile(c.env_file)),
      browser: process.env.BRIDGEDEV_DEPLOY_BROWSER || undefined,
      crash_test: process.env.BRIDGEDEV_DEPLOY_CRASH_TEST === "true",
      ...(options?.shadowLease?{shadow_lease:options.shadowLease}:{}),
    };
  await fs.mkdir(jobDirectory(root, id), { recursive: true, mode: 0o700 });
  await atomicJson(path.join(lock, "owner.json"), {
    version: 1,
    job: id,
    token: randomUUID(),
  });
  await atomicJson(path.join(jobDirectory(root, id), "request.json"), job);
  await record(job, { status: "PENDING" });
  const worker = path.join(sourceRoot, "dist/service-worker.js"),
    q = systemdQuote;
  try {
    await new Promise<void>((resolve, reject) => {
      const command = spawn(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--unit=" + job.unit,
          "--property=Type=exec",
          "--property=NoNewPrivileges=yes",
          "--property=UMask=0077",
          "--property=RuntimeMaxSec=180s",
          "--property=TimeoutStopSec=5s",
          "--property=KillMode=control-group",
          "--property=ExecStopPost=" +
            [process.execPath, worker, "guard", root, id]
              .map((value) => q(value))
              .join(" "),
          process.execPath,
          worker,
          "run",
          root,
          id,
        ],
        { env: operatorEnvironment(), stdio: "ignore" },
      );
      command.once("error", reject);
      command.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(Error("SERVICE_JOB_LAUNCH_UNCONFIRMED")),
      );
    });
  } catch {
    throw Error(
      "SERVICE_JOB_LAUNCH_UNCONFIRMED: " + id + "; inspect status before retry",
    );
  }
  return {
    job_id: id,
    unit: job.unit,
    status: "PENDING",
    log_command: "journalctl --user -u " + job.unit,
  };
}
async function loadJob(root: string, id: string): Promise<ServiceJob> {
  const job = JSON.parse(
    await fs.readFile(
      path.join(jobDirectory(root, id), "request.json"),
      "utf8",
    ),
  ) as ServiceJob;
  if (
    job.version !== 1 ||
    job.id !== id ||
    job.root !== root ||
    job.unit !== "bridge-dev-update-" + id + ".service" ||
    !["update", "rollback", "adopt"].includes(job.operation) ||
    !/^[a-f0-9]{40}$/.test(job.target)
  )
    throw Error("SERVICE_JOB_FUTURE_OR_INVALID");
  if (
    (job.browser &&
      (!path.isAbsolute(job.browser) || /[\x00-\x1f]/.test(job.browser))) ||
    (job.crash_test !== undefined && typeof job.crash_test !== "boolean")
  )
    throw Error("SERVICE_JOB_ACCEPTANCE_INVALID");
  if(job.shadow_lease && (job.operation!=="update" ||
    job.shadow_lease.mode!=="YOLO" || job.shadow_lease.scope!=="host-root-v1" ||
    !/^[a-f0-9]{64}$/.test(job.shadow_lease.fingerprint) ||
    (job.shadow_lease.expires_at!==null && !Number.isSafeInteger(job.shadow_lease.expires_at))))
    throw Error("SERVICE_SHADOW_LEASE_PROOF_INVALID");
  const config = await readServiceConfig(root);
  if (
    !config ||
    config.env_file !== job.before.env_file ||
    config.unit !== job.before.unit
  )
    throw Error("SERVICE_JOB_CONFIGURATION_CHANGED");
  return job;
}
async function releaseLock(job: ServiceJob) {
  const owner = await lockOwner(job.root);
  if (owner?.job === job.id)
    await fs.rm(path.join(job.root, "service/update.lock"), {
      recursive: true,
      force: true,
    });
}
async function assertProtected(job: ServiceJob) {
  if (hash(await fs.readFile(job.before.env_file)) !== job.env_hash)
    throw Error("SERVICE_CREDENTIAL_SOURCE_CHANGED");
  if (job.audit_prefix) {
    const b = await fs.readFile(job.before.audit_file),
      s = await fs.stat(job.before.audit_file);
    if (
      s.ino !== job.audit_prefix.inode ||
      (s.mode & 0o777) !== job.audit_prefix.mode ||
      b.length < job.audit_prefix.bytes ||
      hash(b.subarray(0, job.audit_prefix.bytes)) !== job.audit_prefix.digest
    )
      throw Error("SERVICE_AUDIT_PREFIX_CHANGED");
  }
  verifyAuditFile(job.before.audit_file);
}
export async function rollbackServiceJob(
  root: string,
  id: string,
  reason = "Controller failure or timeout",
): Promise<void> {
  const job = await loadJob(root, id),
    r = await jobResult(root, id);
  if (["SUCCESS", "ROLLED_BACK", "FAILED"].includes(r.status)) {
    await releaseLock(job);
    return;
  }
  // Never stop a live service when preflight has not started the transaction.
  if (["PENDING", "VERIFYING"].includes(r.status)) {
    if(job.shadow_lease)await auditEvent(job.before,{
      operation:"update",job:id,outcome:"shadow_failed",reason:String(reason).slice(0,130),
    }).catch(()=>{}); // Receipt remains durable even if the live audit API is unavailable.
    for (const name of await fs.readdir(jobDirectory(root, id)))
      if (name.startsWith(".probe-") || name.startsWith(".shadow-"))
        await fs.rm(path.join(jobDirectory(root, id), name), {
          recursive: true,
          force: true,
        });
    await record(job, { status: "FAILED", exit_code: 1, error: reason });
    await releaseLock(job);
    return;
  }
  if (
    job.transient &&
    (await systemctl(["is-active", job.transient.unit], false)).trim() ===
      "active"
  ) {
    await record(job, {
      status: "ROLLED_BACK",
      exit_code: 1,
      error: reason,
      commit: job.before.current,
    });
    await releaseLock(job);
    return;
  }
  await systemctl(["stop", job.before.unit], false);
  if (job.operation === "adopt")
    await systemctl(["disable", job.before.unit], false);
  await pointCurrent(root, job.before.current);
  await writeServiceConfig({
    ...job.before,
    last_operation: "auto_rollback",
    updated_at: new Date().toISOString(),
  });
  await auditOffline(job.before, {
    operation: "rollback",
    job: id,
    outcome: "restoring",
    from: job.target,
    to: job.before.current,
  });
  if (job.operation === "adopt" && job.transient) {
    const t = job.transient;
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        "systemd-run",
        [
          "--user",
          "--unit=" + t.unit.replace(/\.service$/, "-restored.service"),
          "--property=Type=exec",
          "--property=Restart=no",
          "--property=NoNewPrivileges=yes",
          "--property=UMask=0077",
          "--property=KillMode=control-group",
          "--property=TimeoutStopSec=10s",
          "--property=TasksMax=18431",
          "--property=EnvironmentFile=" + job.before.env_file,
          "--working-directory=" + t.cwd,
          t.node,
          path.join(t.app, "dist/index.js"),
        ],
        { env: operatorEnvironment(), stdio: "ignore" },
      );
      p.once("error", reject);
      p.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error("SERVICE_TRANSIENT_RESTORE_FAILED")),
      );
    });
    // Legacy detailed health does not have a commit field. Require auth and mode.
    const env = privateEnvironment(job.before.env_file);
    const end = Date.now() + 15000;
    let ready = false;
    while (Date.now() < end) {
      try {
        const h = await authHealth(job.before);
        if (h.status === "ok") {
          const m = await fetch(`http://127.0.0.1:${job.before.port}/health`, {
            headers: { Authorization: "Bearer " + env.MCP_TOKEN },
            signal: AbortSignal.timeout(2000),
          });
          const detail = (await m.json()) as any;
          if (
            m.ok &&
            detail.runtimeMode === "portable" &&
            detail.fullMachineAccess === false
          ) {
            ready = true;
            break;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!ready) throw Error("SERVICE_TRANSIENT_ROLLBACK_HEALTH_FAILED");
  } else {
    await systemctl(["reset-failed", job.before.unit], false);
    await systemctl(["start", job.before.unit]);
    await healthy(job.before,job.before.current,20000,Boolean(job.shadow_lease));
    if(job.shadow_lease){
      assertSameUpdateLease(job.shadow_lease,snapshotUpdateLease());
      await checkLeasedGateway(job.before);
    }
  }
  await assertProtected(job);
  await record(job, {
    status: "ROLLED_BACK",
    exit_code: 1,
    error: reason,
    commit: job.before.current,
  });
  await releaseLock(job);
}
export async function runServiceJob(root: string, id: string): Promise<void> {
  const job = await loadJob(root, id);
  try {
    await record(job, { status: "VERIFYING" });
    const disk = await fs.statfs(root);
    if (Number(disk.bavail) * Number(disk.bsize) < 512 * 1048576)
      throw Error("SERVICE_ROLLBACK_DISK_SPACE_REQUIRED: 512 MiB free");
    await verifyRelease(path.join(root, "releases", job.target), job.target);
    if(job.shadow_lease){
      assertSameUpdateLease(job.shadow_lease,snapshotUpdateLease());
      const shadow=await runShadowAcceptance(
        path.join(root,"releases",job.target),jobDirectory(root,id),job.before.port,job.before.node);
      await record(job,{status:"VERIFYING",acceptance:{shadow}});
      assertSameUpdateLease(job.shadow_lease,snapshotUpdateLease());
      await auditEvent(job.before,{operation:"update",job:id,outcome:"shadow_accepted",
        checks:shadow.checks,lease:"verified_unchanged"});
    }else{
      await probeRelease(path.join(root,"releases",job.target),jobDirectory(root,id));
      await requireStandardServiceMode(job.before);
    }
    if (hash(await fs.readFile(job.before.env_file)) !== job.env_hash)
      throw Error("SERVICE_CREDENTIAL_SOURCE_CHANGED");
    await record(job, { status: "STOPPING" });
    if (job.operation === "adopt" && job.transient)
      await systemctl(["stop", job.transient.unit]);
    else await systemctl(["stop", job.before.unit]);
    const bytes = await fs
      .readFile(job.before.audit_file)
      .catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return Buffer.alloc(0);
        throw e;
      });
    verifyAuditFile(job.before.audit_file);
    if (bytes.length) {
      const st = await fs.stat(job.before.audit_file);
      job.audit_prefix = {
        bytes: bytes.length,
        digest: hash(bytes),
        inode: st.ino,
        mode: st.mode & 0o777,
      };
      await atomicJson(path.join(jobDirectory(root, id), "request.json"), job);
    }
    await auditOffline(job.before, {
      operation: job.operation,
      job: id,
      outcome: "switching",
      from: job.before.current,
      to: job.target,
    });
    await pointCurrent(root, job.target);
    const next = {
      ...job.before,
      current: job.target,
      previous: job.before.current,
      last_operation:
        job.operation === "rollback"
          ? ("rollback" as const)
          : ("update" as const),
      updated_at: new Date().toISOString(),
    };
    await writeServiceConfig(next);
    await record(job, { status: "SWITCHED" });
    await systemctl(["reset-failed", next.unit], false);
    await systemctl(["start", next.unit]);
    await healthy(next,next.current,20000,Boolean(job.shadow_lease));
    const acceptance = job.shadow_lease
      ? {shadow_accepted:true,smoke:await checkLeasedGateway(next)}
      : await checkGateway(next);
    if(job.shadow_lease){
      assertSameUpdateLease(job.shadow_lease,snapshotUpdateLease());
      await auditEvent(next,{operation:"update",job:id,outcome:"positive_smoke_passed",
        lease:"verified_unchanged"});
    }
    if (job.crash_test && !job.shadow_lease) {
      const before = await serviceStatus(root);
      await authHealth(next);
      process.kill(before.pid, "SIGKILL");
      const end = Date.now() + 20000;
      let recovered = false;
      while (Date.now() < end) {
        const status = await serviceStatus(root);
        if (
          status.active &&
          status.pid &&
          status.pid !== before.pid &&
          status.restarts > before.restarts
        ) {
          recovered = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!recovered) throw Error("SERVICE_CRASH_RECOVERY_FAILED");
      await checkGateway(next);
      acceptance.crash_recovery = {
        ok: true,
        previous_pid: before.pid,
        pid: (await serviceStatus(root)).pid,
      };
    }
    if (job.browser && !job.shadow_lease) {
      const { acceptAdminBrowser } = await import(
        pathToFileURL(
          path.join(sourceRoot, "scripts/deploy-acceptance/browser.mjs"),
        ).href
      );
      acceptance.browser = await acceptAdminBrowser({
        binary: job.browser,
        adminUrl: `http://127.0.0.1:${next.admin_port}`,
        adminToken: privateEnvironment(next.env_file).ADMIN_TOKEN,
        evidence: path.join(jobDirectory(root, id), "browser"),
      });
    }
    await assertProtected(job);
    if(job.shadow_lease)assertSameUpdateLease(job.shadow_lease,snapshotUpdateLease());
    acceptance.completion_audit = await completeServiceAudit(next, {
      operation: job.operation,
      job: id,
      outcome: "success",
      from: job.before.current,
      to: job.target,
    });
    if (job.operation === "adopt") await systemctl(["enable", next.unit]);
    // Rolling back a gateway must retain the newer management implementation.
    if (job.operation !== "rollback")
      await pointCurrent(root, job.target, "operator");
    else if (!sync.existsSync(path.join(root, "operator"))) {
      const beforeManifest = await verifyRelease(
        path.join(root, "releases", job.before.current),
      );
      if (
        beforeManifest.files.some(
          (file) => file.path === "dist/service-worker.js",
        )
      )
        await pointCurrent(root, job.before.current, "operator");
    }
    const status = await serviceStatus(root);
    await record(job, {
      status: "SUCCESS",
      exit_code: 0,
      commit: next.current,
      pid: status.pid,
      acceptance,
    });
    await releaseLock(job);
  } catch (error) {
    const env = privateEnvironment(job.before.env_file);
    let reason = String(error instanceof Error ? error.message : error);
    for (const [key, value] of Object.entries(env))
      if (/TOKEN|SECRET|PASSWORD|KEY/.test(key) && value.length > 8)
        reason = reason.replaceAll(value, "[REDACTED]");
    await rollbackServiceJob(root, id, reason);
    throw Error("SERVICE_UPDATE_FAILED: " + id + "; " + reason);
  }
}
/** A staged release can be reused by the local CLI and the transient job.
 * The exact SHA, immutable file digests and GitHub CI evidence must all match.
 * Existing but invalid candidate directories fail closed instead of refetching. */
export async function verifiedStagedRelease(
  ref:string,root=serviceRoot()
):Promise<{commit:string;release:string}|null>{
  if(!/^[a-f0-9]{40}$/.test(ref))return null;
  const candidate=path.join(root,"releases",ref);
  if(!sync.existsSync(candidate))return null;
  const manifest=await verifyRelease(candidate,ref);
  if(manifest.evidence?.verified_ci!==true ||
     manifest.evidence?.repository!=="kmanisk/bridge-dev" ||
     !Number.isSafeInteger(manifest.evidence?.workflow_run) ||
     !/^sha256:[a-f0-9]{64}$/.test(String(manifest.evidence?.artifact_digest)))
    throw Error("SERVICE_STAGED_PROVENANCE_INVALID");
  return {commit:ref,release:candidate};
}
export async function updateService(
  ref: string,
  root = serviceRoot(),
): Promise<Record<string, unknown>> {
  const c = await readServiceConfig(root);
  if (!c) throw Error("SERVICE_NOT_INSTALLED");
  await requireStandardServiceMode(c);
  const staged = await verifiedStagedRelease(ref,root) ||
    await stageVerifiedGithubRelease(ref,root);
  if (staged.commit === c.current) {
    await verifyRelease(staged.release, c.current);
    return { already_current: true, current: c.current };
  }
  return queueServiceOperation("update", staged.commit, root);
}
export async function requestRollback(
  root = serviceRoot(),
): Promise<Record<string, unknown>> {
  const c = await readServiceConfig(root);
  if (!c) throw Error("SERVICE_NOT_INSTALLED");
  await requireStandardServiceMode(c);
  if (c.last_operation === "rollback")
    return { already_rolled_back: true, current: c.current };
  if (!c.previous) throw Error("SERVICE_NO_PREVIOUS_RELEASE");
  return queueServiceOperation("rollback", c.previous, root);
}
