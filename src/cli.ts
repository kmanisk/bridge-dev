#!/usr/bin/env node
import {readPortableMode} from "./lib/portable-mode.js";

/**
 * BridgeDev CLI — Self-hosted MCP Development Gateway
 */

import "dotenv/config";
import {startConfiguredService,installService,controlService,queueServiceOperation,jobResult,verifiedStagedRelease} from "./lib/service-manager.js";
import {snapshotUpdateLease,assertSameUpdateLease,assertLocalUpdateCgroup} from "./lib/update-lease.js";
import {offerPersistentBootService} from "./lib/yolo-autostart.js";
import {serviceCli} from "./lib/service-cli.js";
import {stageVerifiedGithubRelease} from "./lib/service-release.js";
import {serviceRoot} from "./lib/service-config.js";
import {rotateCredentialFile,inspectCredentialFile,credentialFilePath} from "./lib/token-rotation.js";
import {monitorCli} from "./lib/monitor-cli.js";
import {checkLatestMain,formatUpdateHint} from "./lib/release-notice.js";
import {runtimeVersion} from "./lib/service-config.js";
import {coordinatedVerifiedUpdate} from "./lib/coordinated-update.js";
import {readServiceConfig,serviceStatus as userServiceStatus} from "./lib/service-config.js";
import {verifyAuditFile,redactAudit} from "./lib/hash-audit.js";
import {extensionCli,operatorApi} from "./lib/extension-cli.js";
import {controllerCli} from "./lib/controller-cli.js";
import {parseCliArguments} from "./lib/cli-arguments.js";
import {cliErrorMessage,cliLogFile,writeCliEvent} from "./lib/cli-report.js";
import {hostControllerAvailable} from "./lib/host-controller.js";
import {mintAdminPairCode} from "./admin/local-session.js";
import {tailscaleEndpoint,enableTailscaleFunnel} from "./lib/tailscale.js";
import { execSync, spawnSync, execFileSync } from "node:child_process";
import {createInterface} from "node:readline/promises";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { formatMcpEndpoint, inspectLocalMode, resolveProjectDirectory, validateProjectName, verifyAuditProof } from "./lib/cli-security.js";
import { platformCapabilities, getRuntimeMode, portableStateDir, portableWorkspace, portableWorkspaceRoots } from "./lib/runtime.js";

const VERSION = "2.0.0";

// Fallback dotenv loading if environment variables are not populated
const envCandidates = [
  process.env.DOTENV_CONFIG_PATH,
  path.join(os.homedir(), ".config", "bridge-dev", ".env"),
  path.join(process.cwd(), ".env"),
].filter(Boolean) as string[];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (!process.env[key]) process.env[key] = val;
        }
      }
      break;
    } catch {}
  }
}

// Standard canonical & backward-compatible paths
const CANONICAL_DIRS = {
  opt: "/opt/bridge-dev",
  etc: "/etc/bridge-dev",
  lib: "/var/lib/bridge-dev",
  log: "/var/log/bridge-dev",
  srv: "/srv/bridge-dev",
};

const LEGACY_DIRS = {
  opt: "/opt/local-coder-policygate",
  etc: "/etc/local-coder-policygate",
  lib: "/var/lib/local-coder-policygate",
  log: "/var/log/local-coder-policygate",
  srv: "/srv/local-coder",
};

function getActivePath(sub: "etc" | "lib" | "log" | "srv" | "opt"): string {
  if (getRuntimeMode() === "portable") return path.join(portableStateDir(), sub);
  const canon = CANONICAL_DIRS[sub];
  const legacy = LEGACY_DIRS[sub];
  if (fs.existsSync(canon)) return canon;
  if (fs.existsSync(legacy)) return legacy;
  return canon;
}

function getServiceUnit(): string | null {
  if (process.platform !== "linux" || getRuntimeMode() === "portable") return null;
  const units = [
    "bridge-dev.service",
    "chatgpt-local-coder-policygate.service",
    "chatgpt-local-coder.service",
  ];
  for (const u of units) {
    try {
      const out = execSync(`systemctl is-active ${u} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (out === "active" || out === "activating") return u;
    } catch {}
  }
  return null;
}

interface HealthResponse {
  status: string;
  runtimeMode?: string;
  name?: string;
  workspace?: string;
  activeSessions?: number;
  instructions?: {
    tool_profile?: string;
  };
}

function fetchHealth(port = 3000): Promise<HealthResponse | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500,headers:{Authorization:"Bearer "+(process.env.MCP_TOKEN||"")} }, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function getActiveMode(): { mode: string; detail: string } {
  if (hostControllerAvailable()) {
    const libDir = fs.existsSync("/var/lib/local-coder-policygate")
      ? "/var/lib/local-coder-policygate"
      : fs.existsSync("/var/lib/bridge-dev")
      ? "/var/lib/bridge-dev"
      : getActivePath("lib");
    const etcDir = fs.existsSync("/etc/local-coder-policygate")
      ? "/etc/local-coder-policygate"
      : fs.existsSync("/etc/bridge-dev")
      ? "/etc/bridge-dev"
      : getActivePath("etc");
    const reading = inspectLocalMode({
      stateDir: libDir,
      publicKeyFile: process.env.POLICYGATE_APPROVAL_PUBLIC_KEY || path.join(etcDir, "operator-public.pem"),
      leaseFile: process.env.POLICYGATE_YOLO_LEASE || path.join(libDir, "yolo-lease.json"),
      modeFile: process.env.POLICYGATE_MODE_FILE || path.join(libDir, "mode.json"),
      activationFile: process.env.POLICYGATE_YOLO_ACTIVATION_FILE || "/var/lib/bridge-dev-operator/active-lease.json",
    });
    if (reading.mode === "YOLO") return reading;
  }
  if (getRuntimeMode() === "portable") {
    try {
      const mode = JSON.parse(fs.readFileSync(path.join(portableStateDir(), "mode.json"), "utf8"));
      if (mode.mode === "strict") return { mode: "STRICT", detail: "portable; stdio providers refused" };
    } catch {}
    return { mode: "STANDARD", detail: "portable scoped policy; OS account permissions apply" };
  }
  const libDir = getActivePath("lib");
  const etcDir = getActivePath("etc");
  return inspectLocalMode({
    stateDir: libDir,
    publicKeyFile: process.env.POLICYGATE_APPROVAL_PUBLIC_KEY || path.join(etcDir, "operator-public.pem"),
    leaseFile: process.env.POLICYGATE_YOLO_LEASE || path.join(libDir, "yolo-lease.json"),
    modeFile: process.env.POLICYGATE_MODE_FILE || path.join(libDir, "mode.json"),
    activationFile: process.env.POLICYGATE_YOLO_ACTIVATION_FILE || (hostControllerAvailable() ? "/var/lib/bridge-dev-operator/active-lease.json" : undefined),
  });
}

function getTailscaleEndpoint(): string | null {
  return tailscaleEndpoint(Number(process.env.PORT || 3000));
}

function getMappedProjects(): string[] {
  const srvDir = getActivePath("srv");
  const projDir = path.join(srvDir, "projects");
  if (!fs.existsSync(projDir)) return [];
  try {
    return fs.readdirSync(projDir).filter((f) => {
      const p = path.join(projDir, f);
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    });
  } catch {
    return [];
  }
}

async function cmdStatus(json = false,verbose = false) {
  const service = await userServiceStatus();
  const unit = getServiceUnit();
  const health = await fetchHealth(Number(process.env.PORT || 3000));
  const modeInfo = getActiveMode();
  const funnel = getTailscaleEndpoint();
  const projects = getMappedProjects();
  const roots = portableWorkspaceRoots();

  let serviceStatus = "stopped";
  let pid = "N/A";
  if (unit) {
    serviceStatus = "active";
    try {
      pid = execSync(`systemctl show -p MainPID --value ${unit} 2>/dev/null`, { encoding: "utf8" }).trim();
    } catch {}
  }

  const localEndpoint = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const endpointStr = funnel ? `${funnel} -> ${localEndpoint}` : localEndpoint + " (local only)";

  const profile = health?.instructions?.tool_profile || "slim";
  const sessions = health?.activeSessions ?? 0;
  const workspace = health?.workspace || (getRuntimeMode() === "portable" ? portableWorkspace() : path.join(getActivePath("srv"), "workspace"));

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      version: VERSION,
      platform: process.platform,
      runtime: health?.runtimeMode || (unit ? "managed" : getRuntimeMode()),
      service: {
        installed: service.installed,
        unit: service.unit || unit || null,
        state: service.state || serviceStatus,
        pid: service.pid || (pid !== "N/A" ? Number(pid) : null),
        enabled: service.enabled,
        linger: service.linger,
      },
      status: health ? "connected" : "offline",
      sessions,
      profile,
      mode: modeInfo.mode,
      mode_detail: modeInfo.detail,
      default_workspace: workspace,
      authorized_workspaces: roots,
      endpoint: localEndpoint,
      public_url: funnel || null,
    }));
    return;
  }

  if(!verbose){
    const state=health||service.active?"running":service.installed?"stopped":"offline";
    const release=service.current ? " · "+service.current.slice(0,7) : "";
    console.log(`BridgeDev: ${state} · ${modeInfo.mode}${release}`);
    if(service.active&&!health)console.warn("Warning: MCP health unverified; check credentials/port with bridge-dev doctor --verbose.");
    if(service.installed&&!service.pointer_consistent)console.warn("Warning: release pointer mismatch; inspect bridge-dev doctor --verbose.");
    writeCliEvent({command:"status",status:service.active&&!health?"RUNNING_UNVERIFIED":state,
      release:service.current||undefined});
    return;
  }

  console.log(`BridgeDev v${VERSION}`);
  console.log(`Runtime   : ${health?.runtimeMode || (unit ? "managed system service" : getRuntimeMode())} on ${process.platform}`);
  console.log(`Service   : ${service.installed ? service.unit + " " + service.state + " (PID: " + service.pid + ")" : unit ? serviceStatus + ` (PID: ${pid}, systemd: ${unit})` : health ? "foreground server reachable" : "not detected"}`);
  console.log(`Status    : ${health ? "connected" : "offline"}${health ? ` (Profile: ${profile}, Active Sessions: ${sessions})` : ""}`);
  console.log(`Mode      : ${modeInfo.mode} (${modeInfo.detail})`);
  console.log(`Workspace : ${workspace}`);
  const extras = roots.filter(r => r !== workspace);
  if (extras.length) {
    console.log(`Authorized: ${extras.join(", ")}`);
  }
  if (projects.length) {
    console.log(`Projects  : ${projects.length} mapped project${projects.length === 1 ? "" : "s"}`);
  }
  console.log(`Endpoint  : ${endpointStr}`);
  if (service.installed) console.log("Boot      : enabled=" + service.enabled + ", linger=" + service.linger_status + ", commit=" + service.current + ", rollback=" + (service.previous || "none"));
  console.log("Next step : Run 'bridge-dev help' for commands or 'bridge-dev doctor' for diagnostics.");
}

async function cmdConnect(showToken = false) {
  const funnel = getTailscaleEndpoint();
  const baseUrl = funnel || `http://127.0.0.1:${process.env.PORT || 3000}`;
  let token = "";
  if (showToken) {
    const envFile = process.env.POLICYGATE_ENV_FILE || path.join(getActivePath("etc"), "service.env");
    try {
      const match = fs.readFileSync(envFile, "utf8").match(/^MCP_TOKEN=(.+)$/m);
      token = match?.[1]?.trim() || "";
    } catch {}
    if (!token) token = process.env.MCP_TOKEN || "";
  }
  const endpoint = formatMcpEndpoint(baseUrl, token, showToken);
  console.log("BridgeDev MCP connection");
  console.log("Endpoint : " + endpoint);
  console.log("Protocol : Streamable HTTP MCP");
  console.log("Auth     : Legacy URL token shown; /mcp also accepts a Bearer token");
  console.log(`Admin UI : http://127.0.0.1:${process.env.ADMIN_PORT || 3001} (local only, separate admin token)`);
  console.log("");
  console.log("ChatGPT: configure the custom MCP connector URL to the endpoint above.");
  console.log("Codex/Claude Code: use this MCP server URL in the client configuration:");
  console.log(JSON.stringify({mcpServers:{"bridge-dev":{url:endpoint}}},null,2));
  if (!showToken) {
    console.log("Replace <MCP_TOKEN> locally with your configured MCP token.");
    console.log("Use --show-token only in a private terminal; URLs containing tokens are secrets.");
  } else if (!token) {
    console.error("Token is not readable here; retrieve it from the independent operator securely.");
  }
}

function getEnvConfigPath(): string {
  if (process.env.DOTENV_CONFIG_PATH && fs.existsSync(process.env.DOTENV_CONFIG_PATH)) return process.env.DOTENV_CONFIG_PATH;
  const userEnv = path.join(os.homedir(), ".config", "bridge-dev", ".env");
  if (fs.existsSync(userEnv)) return userEnv;
  const localEnv = path.resolve(process.cwd(), ".env");
  return localEnv;
}

function updateEnvVariable(key: string, value: string): void {
  const envFile = getEnvConfigPath();
  let content = "";
  try { content = fs.readFileSync(envFile, "utf8"); } catch {}
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}="${value}"`);
  } else {
    content = (content.trimEnd() + `\n${key}="${value}"\n`).trimStart();
  }
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, content, { mode: 0o600 });
}

function cmdWorkspace(args: string[], json = false) {
  const action = (args[0] || "list").toLowerCase();
  const roots = portableWorkspaceRoots();
  const defaultCwd = portableWorkspace();

  if (action === "list") {
    if (json) {
      console.log(JSON.stringify({ ok: true, default_workspace: defaultCwd, authorized_roots: roots }));
      return;
    }
    console.log("Authorized Workspaces:");
    console.log(`  Default workspace : ${defaultCwd}`);
    const extras = roots.filter(r => r !== defaultCwd);
    if (extras.length) {
      console.log("  Additional authorized roots:");
      for (const r of extras) console.log(`    - ${r}`);
    } else {
      console.log("  (no additional roots configured; use 'bridge-dev workspace add <path>')");
    }
    return;
  }

  if (action === "add") {
    const rawPath = args[1];
    if (!rawPath) {
      console.error("Usage: bridge-dev workspace add <path>");
      process.exitCode = 1;
      return;
    }
    const resolved = path.resolve(rawPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      console.error(`Invalid workspace: directory not found at ${resolved}`);
      process.exitCode = 1;
      return;
    }
    const currentExtras = (process.env.EXTRA_WORKSPACE_PATHS || "")
      .split(/[;,]/)
      .map(p => p.trim())
      .filter(Boolean);
    if (!currentExtras.includes(resolved)) {
      currentExtras.push(resolved);
      updateEnvVariable("EXTRA_WORKSPACE_PATHS", currentExtras.join(";"));
      process.env.EXTRA_WORKSPACE_PATHS = currentExtras.join(";");
    }
    if (json) {
      console.log(JSON.stringify({ ok: true, added: resolved, authorized_roots: portableWorkspaceRoots() }));
      return;
    }
    console.log(`Added authorized workspace root: ${resolved}`);
    console.log("Restart BridgeDev ('bridge-dev restart') for changes to take effect.");
    return;
  }

  if (action === "remove" || action === "rm") {
    const rawPath = args[1];
    if (!rawPath) {
      console.error("Usage: bridge-dev workspace remove <path>");
      process.exitCode = 1;
      return;
    }
    const resolved = path.resolve(rawPath);
    const currentExtras = (process.env.EXTRA_WORKSPACE_PATHS || "")
      .split(/[;,]/)
      .map(p => p.trim())
      .filter(Boolean);
    const filtered = currentExtras.filter(p => path.resolve(p) !== resolved);
    updateEnvVariable("EXTRA_WORKSPACE_PATHS", filtered.join(";"));
    process.env.EXTRA_WORKSPACE_PATHS = filtered.join(";");
    if (json) {
      console.log(JSON.stringify({ ok: true, removed: resolved, authorized_roots: portableWorkspaceRoots() }));
      return;
    }
    console.log(`Removed workspace root: ${resolved}`);
    console.log("Restart BridgeDev ('bridge-dev restart') for changes to take effect.");
    return;
  }

  console.error("Usage: bridge-dev workspace [list | add <path> | remove <path>]");
  process.exitCode = 1;
}

/**
 * Re-pair a local browser without exposing the long-lived Admin credential.
 * A local interactive operator must initiate this action; remote MCP calls,
 * pipes, and redirected output may never mint or open pairing links.
 */
function cmdDashboard(): void {
  if (getRuntimeMode() !== "portable" || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw Error("DASHBOARD_LOCAL_TTY_REQUIRED: launch from your own private local terminal");
  }
  if (process.platform !== "linux") {
    throw Error("DASHBOARD_OPENER_UNAVAILABLE: use bridge-dev access from your private terminal");
  }
  const admin = process.env.ADMIN_TOKEN || "";
  const port = process.env.ADMIN_PORT || "3001";
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw Error("DASHBOARD_ADMIN_PORT_INVALID");
  if (admin.length < 32)
    throw Error("DASHBOARD_ADMIN_CREDENTIAL_MISSING: verify the operator-owned .env");
  const link = `http://127.0.0.1:${port}/ui/#pair=${mintAdminPairCode(admin)}`;
  const result = spawnSync("xdg-open", [link], {
    stdio: "ignore",
    timeout: 8000,
  });
  if (result.error || result.status !== 0)
    throw Error("DASHBOARD_BROWSER_OPEN_FAILED: use bridge-dev access for a one-use pairing link");
  console.log("Opened BridgeDev dashboard with a 60-second signed local pairing link.");
  console.log("No Admin bearer token was printed or stored by the CLI.");
}

function cmdAccess(): void {
  // Never return credentials to MCP tools, pipes, redirected logs or JSON mode.
  // A user requests them explicitly from a private interactive terminal.
  if (getRuntimeMode() !== "portable" || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Access details are available only from a private interactive terminal in portable mode.");
    process.exitCode = 1;
    return;
  }
  const mcp = process.env.MCP_TOKEN || "";
  const admin = process.env.ADMIN_TOKEN || "";
  if (!mcp || !admin || mcp === admin) {
    console.error("Portable credentials not configured; run 'bridge-dev setup' first.");
    process.exitCode = 1;
    return;
  }
  const port = process.env.PORT || "3000";
  const adminPort = process.env.ADMIN_PORT || "3001";
  const funnel = getTailscaleEndpoint();
  const baseMcpUrl = funnel || `http://127.0.0.1:${port}`;
  const connectionUrl = `${baseMcpUrl}/mcp/${mcp}`;
  const dashboardUrl = `http://127.0.0.1:${adminPort}/ui/`;

  console.log("BridgeDev Access & Integration Guide\n");
  console.log("Connection URL (paste into ChatGPT Web):");
  console.log(`  ${connectionUrl}\n`);
  console.log("Dashboard URL (local operations interface):");
  console.log(`  ${dashboardUrl}\n`);
  console.log("One-click local Admin pairing (valid 60 seconds; private terminal only):");
  console.log(`  ${dashboardUrl}#pair=${mintAdminPairCode(admin)}\n`);
  console.log("ChatGPT Web Setup Steps (Add custom MCP server):");
  console.log("  1. Name          : BridgeDev");
  console.log("  2. Connection    : Select 'Server URL' and paste the Connection URL above");
  console.log("  3. Authentication: Select 'None' (Authentication token is embedded in the URL)");
  console.log("  4. Save          : Click Add / Save to begin using native workstation tools\n");
  console.log("Dashboard Authentication:");
  console.log("  Open the 60-second pairing link once. A signed HttpOnly session persists across page reloads and service restarts.");
  console.log("  Keep pairing links private; Admin token rotation invalidates existing browser sessions.");
}

function runOperator(args: string[]): boolean {
  if (process.platform !== "linux") {
    console.error("Signed operator mode control requires the hardened Linux installation.");
    process.exitCode = 1;
    return false;
  }
  const script = fs.existsSync("/usr/local/libexec/bridge-dev/policygate-operator.mjs")
    ? "/usr/local/libexec/bridge-dev/policygate-operator.mjs"
    : path.join(getActivePath("opt"), "scripts", "policygate-operator.mjs");
  if (!fs.existsSync(script)) {
    console.error("Operator script not installed: " + script);
    process.exitCode = 1;
    return false;
  }
  // The operator script independently requires real root UID and an interactive terminal.
  const run = spawnSync("sudo", ["--", process.execPath, script, ...args], {stdio:"inherit"});
  if (run.error || run.status !== 0) {
    console.error("Operator authorization failed. Use an independent local root terminal.");
    process.exitCode = run.status || 1;
    return false;
  }
  return true;
}

/**
 * Runs only AFTER the independent, TTY-only root operator confirms YOLO.
 * Nothing is installed or privileged merely because the first prompt was accepted.
 */
async function offerBootAutostartAfterLocalYolo(): Promise<void> {
  if (process.platform !== "linux" || !process.stdin.isTTY || !process.stdout.isTTY) return;
  try {
    await offerPersistentBootService({
      status: async () => {
        const status=await userServiceStatus();
        return {
          installed:status.installed===true,
          enabled:status.enabled===true,
          linger:status.linger===true,
          active:status.active===true,
          unit:typeof status.unit==="string"?status.unit:undefined,
        };
      },
      confirm: async () => {
        const prompt = createInterface({input:process.stdin,output:process.stdout});
        try {
          const answer = await prompt.question(
            "Enable persistent BridgeDev systemd service at boot? [Y/n] "
          );
          const t = answer.trim();
          return t === "" || /^(y|yes)$/i.test(t);
        } finally {
          prompt.close();
        }
      },
      install: async () => {
        // Never start/restart a possibly running gateway or alter its credentials.
        await installService({enable:true,start:false});
        console.log("Installed the BridgeDev user service using the existing verified release.");
        console.log("A fresh user unit uses the standard sandbox; host-root commands need a separately reviewed controller-compatible unit.");
      },
      enable: async () => { await controlService("enable"); },
      enableLinger: async () => {
        const uid=process.getuid?.();
        if (!Number.isInteger(uid) || uid === 0)
          throw Error("YOLO_BOOT_LINGER_REQUIRES_REAL_USER");
        const result=spawnSync("/usr/bin/sudo",["--","/usr/bin/loginctl","enable-linger",String(uid)],{stdio:"inherit"});
        if (result.error || result.status!==0)
          throw Error("YOLO_BOOT_LINGER_FAILED: verify sudo loginctl enable-linger for the local operator");
      },
      log: (message) => console.log(message),
    });
  } catch (error) {
    // Do not revoke or falsely report the separately authorized signed lease.
    console.error("Full System remains active, but optional boot setup did not complete: "+(error instanceof Error?error.message:String(error)));
    process.exitCode = 1;
  }
}

async function cmdMode(args: string[], json = false) {
  const target = args[0]?.toLowerCase();
  if (!target || target === "status") {
    const reading = getActiveMode();
    const label = reading.mode === "YOLO" ? "Full System (sudo)" :
      reading.mode === "STANDARD" ? "Read & Write" :
      reading.mode === "STRICT" ? "Unavailable (internal safety lock)" : "Operator-only / unverified";
    if (json) {
      console.log(JSON.stringify({ ok: true, mode: reading.mode, label, detail: reading.detail }));
      return;
    }
    console.log("Mode: " + label + " (" + reading.detail + ")");
    if (reading.mode === "STRICT")
      console.log("Protected state prevents Read & Write. Use 'bridge-dev mode standard' from your own terminal.");
    if (reading.mode === "UNKNOWN")
      console.log("Mode state is not readable here. Verify with the independent operator and MCP agent_status.");
    return;
  }
  if (["read-write","readwrite","rw","standard"].includes(target)) {
    if (hostControllerAvailable()) {
      if (!runOperator(["mode","standard"])) return;
      const verified = getActiveMode();
      if (verified.mode !== "STANDARD") {
        console.error("STANDARD transition not confirmed: protected state reports " + verified.mode);
        process.exitCode = 1;
        return;
      }
      console.log("Active mode switched to STANDARD.");
      return;
    }
    if (getRuntimeMode()==="portable") {
      console.log(await operatorApi("/api/mode",{mode:"standard"}));
      return;
    }
    runOperator(["mode","standard"]);
    return;
  }
  if (["sudo","full-system","yolo"].includes(target)) {
    if (getRuntimeMode()==="portable" && !process.stdin.isTTY) {
      console.error("Full System (sudo) needs the optional Linux host controller; portable mode cannot elevate.");
      process.exitCode = 1;
      return;
    }
    if (!hostControllerAvailable() && getRuntimeMode()==="portable") {
      console.error("Full System (sudo) needs the optional Linux host controller; portable mode cannot elevate.");
      process.exitCode = 1;
      return;
    }
    if (args.includes("--off")) {
      if (!runOperator(["mode","standard"])) return;
      const verified = getActiveMode();
      if (verified.mode !== "STANDARD") {
        console.error("Full System revocation not confirmed: protected state reports " + verified.mode);
        process.exitCode = 1;
        return;
      }
      console.log("Full System deactivated. Returned to STANDARD mode.");
      return;
    }
    const durIdx = args.indexOf("--duration");
    const dur = durIdx >= 0 ? args[durIdx + 1] : undefined;
    const opArgs = dur ? ["yolo", "--duration", dur] : ["yolo", "--until-off"];
    if (!runOperator(opArgs)) return;
    const mode = getActiveMode();
    if (mode.mode === "YOLO") {
      console.log("Full System (YOLO) active: " + mode.detail);
      await offerBootAutostartAfterLocalYolo();
    } else {
      console.error("Full System not confirmed: protected state reports " + mode.mode);
      process.exitCode = 1;
    }
    return;
  }
  console.error("Usage: bridge-dev mode [standard | yolo [--duration <min>] | yolo --off | status]");
  process.exitCode = 1;
}

function cmdProject(args: string[]) {
  const action = args[0]?.toLowerCase() || "list";
  if(action==="unmap"&&args[1])validateProjectName(args[1]);
  if(getRuntimeMode()==="portable"&&action==="list"){console.log("Workspace: "+portableWorkspace());console.log("Portable workspace selection uses WORKSPACE_PATH; managed bind mounts require Linux operator configuration.");return;}
  if (process.platform !== "linux") {
    console.error("Project bind-mount management is supported only by the hardened Linux installation.");
    process.exitCode = 1;
    return;
  }
  if (action === "list") {
    const projects = getMappedProjects();
    console.log("Approved project mappings:");
    if (!projects.length) console.log("  (none readable)");
    for (const project of projects) console.log("  " + project);
    return;
  }
  if (action !== "map" && action !== "unmap") {
    console.error("Usage: bridge-dev project [list | map <path> | unmap <name>]");
    process.exitCode = 1;
    return;
  }
  const provided = args[1];
  if (!provided || args.length !== 2) {
    console.error("Usage: bridge-dev project " + action + " <" + (action==="map"?"path":"name") + ">");
    process.exitCode = 1;
    return;
  }
  let validated: string;
  try {
    validated = action === "map" ? resolveProjectDirectory(provided) : validateProjectName(provided);
  } catch (err) {
    console.error("Invalid project: " + (err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
    return;
  }
  // The independent operator helper owns the ACL, bind-mount and rollback policy.
  // Never construct sudo shell strings or recursively alter ACLs in this client.
  const helper = "/usr/local/bin/policygate-project";
  if (!fs.existsSync(helper)) {
    console.error("Reviewed project-mapping helper not installed: " + helper);
    process.exitCode = 1;
    return;
  }
  const run = spawnSync("sudo", ["--", helper, action, validated], {stdio:"inherit"});
  if (run.error || run.status !== 0) {
    console.error("Project " + action + " failed; no direct fallback will be attempted.");
    process.exitCode = run.status || 1;
  }
}

async function cmdStop() {
  if(getRuntimeMode()==="portable"&&(await readServiceConfig())){await serviceCli(["service","stop"]);return;}
  if (getRuntimeMode() === "portable") {await operatorApi("/api/lifecycle/stop",{});console.log("Foreground gateway stopping");return;}
  if (process.platform !== "linux") {
    console.error("Service stop is Linux systemd-only. Stop a foreground server with Ctrl-C.");
    process.exitCode = 1;
    return;
  }
  const unit = getServiceUnit();
  if (!unit) {
    console.log("BridgeDev service is not running.");
    return;
  }
  console.log(`Stopping ${unit}...`);
  try {
    execSync(`sudo systemctl stop ${unit}`);
    console.log("Service stopped.");
  } catch (err: any) {
    console.error(`Failed to stop service: ${err.message}`);
    process.exit(1);
  }
}

async function cmdRestart() {
  if(getRuntimeMode()==="portable"&&(await readServiceConfig())){await serviceCli(["service","restart"]);return;}
  if (getRuntimeMode() === "portable") {
    await cmdStop();
    await new Promise(resolve=>setTimeout(resolve,500));
    await import("./index.js");
    return;
  }
  if (process.platform !== "linux") {
    console.error("Service restart is Linux systemd-only. Restart foreground processes manually.");
    process.exitCode = 1;
    return;
  }
  const unit = getServiceUnit();
  if (!unit) throw new Error("No managed BridgeDev service is running");
  console.log(`Restarting ${unit}...`);
  try {
    execSync(`sudo systemctl restart ${unit}`);
    let recovered = false;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const health = await fetchHealth(Number(process.env.PORT || 3000));
      if (health) {
        recovered = true;
        break;
      }
    }
    if (recovered) {
      console.log("Service restarted successfully and healthy.");
    } else {
      console.error("Service restart did not restore MCP health on port 3000.");
      process.exitCode = 1;
    }
  } catch (err: any) {
    console.error(`Failed to restart service: ${err.message}`);
    process.exit(1);
  }
}

async function cmdDoctor(json = false,verbose = false) {
  const service = await userServiceStatus();
  const checks: Array<{ label: string; status: "OK" | "UNVERIFIED" | "INFO"; detail: string }> = [];
  const add = (label: string, status: "OK" | "UNVERIFIED" | "INFO", detail: string) => checks.push({ label, status, detail });
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  add("Node runtime", nodeMajor >= 20 ? "OK" : "UNVERIFIED", process.version);
  if (getRuntimeMode() === "portable") {
    add("Persistent service", service.installed && service.active ? "OK" : "INFO", service.installed ? service.unit + " " + service.state : "not installed; foreground runtime");
    if (service.installed) {
      add("Boot activation", service.enabled && service.linger ? "OK" : "UNVERIFIED", "enabled=" + service.enabled + ", linger=" + service.linger_status);
      add("Release pointer", service.pointer_consistent ? "OK" : "UNVERIFIED", service.current);
      add("Rollback", "INFO", service.rollback_available ? service.previous : "no previous release");
      add("Service hardening", service.hardening?.NoNewPrivileges === "yes" ? "OK" : "INFO", JSON.stringify(service.hardening));
    }
    const health = await fetchHealth(Number(process.env.PORT || 3000));
    add("MCP endpoint", health ? "OK" : "UNVERIFIED", health ? "authenticated MCP gateway reachable" : "configured gateway port is unavailable");
    const admin = await new Promise<number>((resolve) => {
      const req = http.get(`http://127.0.0.1:${process.env.ADMIN_PORT || 3001}/health`, { timeout: 1500 }, res => { res.resume(); resolve(res.statusCode || 0); });
      req.on("error", () => resolve(0)); req.on("timeout", () => { req.destroy(); resolve(0); });
    });
    add("Admin endpoint", admin === 401 ? "OK" : admin === 200 ? "UNVERIFIED" : "INFO",
      admin === 401 ? "reachable, unauthenticated request denied" : admin === 200 ? "reachable, but unauthenticated health allowed" : "not running or unreachable");
    const funnel = getTailscaleEndpoint();
    add("Public tunnel", "INFO", funnel || "not configured");
    const { McpUpstreamManager } = await import("./lib/mcp-upstream-manager.js");
    const manager = new McpUpstreamManager();
    await manager.init();
    add("Optional providers", manager.initializationError ? "UNVERIFIED" : "OK", manager.initializationError || manager.listServerConfigs().length + " registered; no providers executed");
    try {
      const proof = verifyAuditFile(path.join(portableStateDir(), "audit.jsonl"));
      add("Application audit", "OK", proof.entries + " chained entries; OS append-only protection not claimed");
    } catch (error) {
      add("Application audit", "UNVERIFIED", String(error));
    }
    const mode = getActiveMode();
    add("Security mode", mode.mode !== "UNKNOWN" ? "OK" : "UNVERIFIED", mode.mode + " — " + mode.detail);
    if (hostControllerAvailable()) {
      add("Host controller", "OK", "installed at /usr/local/bin/bridge-dev-controller");
    } else {
      add("Host controller", "INFO", "optional; not installed");
    }
    if (json) {
      console.log(JSON.stringify({ ok: !checks.some(c => c.status === "UNVERIFIED"), checks }));
      return;
    }
    if(verbose){console.log("BridgeDev doctor");for (const check of checks) console.log("[" + check.status + "] " + check.label.padEnd(22) + ": " + check.detail);}
    else{console.log(`BridgeDev doctor: ${checks.filter(c=>c.status==="OK").length} OK, ${checks.filter(c=>c.status==="UNVERIFIED").length} warnings`);
      for(const c of checks.filter(c=>c.status==="UNVERIFIED"))console.warn(`Warning: ${c.label}: ${c.detail}`);}
    writeCliEvent({command:"doctor",status:checks.some(c=>c.status==="UNVERIFIED")?"WARN":"OK",detail:checks.filter(c=>c.status==="UNVERIFIED").map(c=>c.label).join(", ")});
    if (checks.some(check => check.status === "UNVERIFIED")) process.exitCode = 1;
    return;
  }
  if (process.platform === "linux") {
    const unit = getServiceUnit();
    add("systemd", unit ? "OK" : "UNVERIFIED", unit || "no running BridgeDev system service found");
  } else {
    add("systemd", "INFO", "not available on " + process.platform + "; foreground source build only");
  }
  const health = await fetchHealth(Number(process.env.PORT || 3000));
  add("MCP endpoint", health ? "OK" : "UNVERIFIED", health ? "HTTP 200, sessions: " + (health.activeSessions ?? 0) : "port 3000 unavailable");
  if (process.platform === "linux") {
    const admin = await new Promise<number>((resolve) => {
      const req = http.get(`http://127.0.0.1:${process.env.ADMIN_PORT || 3001}/health`, { timeout: 1500 }, res => { res.resume(); resolve(res.statusCode || 0); });
      req.on("error", () => resolve(0)); req.on("timeout", () => { req.destroy(); resolve(0); });
    });
    add("Admin endpoint", admin === 401 ? "OK" : admin === 200 ? "UNVERIFIED" : "UNVERIFIED",
      admin === 401 ? "reachable, unauthenticated request denied" : admin === 200 ? "reachable, but unauthenticated health allowed" : "not reachable");
    const funnel = getTailscaleEndpoint();
    add("Public tunnel", "INFO", funnel || "not configured");
    const log = path.join(getActivePath("log"), "audit.jsonl");
    const anchor = process.env.POLICYGATE_AUDIT_ANCHOR_FILE || path.join(getActivePath("etc"), "audit-anchor.json");
    try {
      const proof = verifyAuditProof(log, anchor);
      const st = fs.statSync(log), ast = fs.statSync(anchor);
      const flags = execFileSync("lsattr", ["-d", "--", log], { encoding: "utf8", timeout: 3000 }).trim().split(/\s+/)[0] || "";
      if (st.uid !== 0 || (st.mode & 0o777) !== 0o660 || ast.uid !== 0 || !flags.includes("a"))
        throw new Error("owner, permissions, trusted anchor or append-only flag invalid");
      add("Audit ledger", "OK", proof.entries + " chained entries, " + proof.anchoredEntries + " anchored; append-only verified");
    } catch (e) {
      add("Audit ledger", "UNVERIFIED", "chain/anchor/append-only not verified: " +
        (e instanceof Error ? e.message : String(e)) + "; run doctor as an independent root operator");
    }
    const key = path.join(getActivePath("etc"), "operator-public.pem");
    try {
      const st = fs.statSync(key);
      add("Operator public key", st.isFile() && st.uid === 0 ? "OK" : "UNVERIFIED",
        st.isFile() && st.uid === 0 ? "present, root-owned (private key not accessed)" : "invalid ownership or type");
    } catch { add("Operator public key", "UNVERIFIED", "not readable; use independent operator inspection"); }
    const mode = getActiveMode();
    add("Security mode", mode.mode !== "UNKNOWN" ? "OK" : "UNVERIFIED", mode.mode + " — " + mode.detail);
  } else {
    add("Hardened policy checks", "INFO", "not verified outside Linux systemd");
  }
  if (json) {
    console.log(JSON.stringify({ ok: !checks.some(c => c.status === "UNVERIFIED"), checks }));
    return;
  }
  if(verbose){console.log("BridgeDev doctor");for (const c of checks)console.log("["+c.status+"] "+c.label.padEnd(22)+": "+c.detail);}
  else{console.log(`BridgeDev doctor: ${checks.filter(c=>c.status==="OK").length} OK, ${checks.filter(c=>c.status==="UNVERIFIED").length} warnings`);
    for(const c of checks.filter(c=>c.status==="UNVERIFIED"))console.warn(`Warning: ${c.label}: ${c.detail}`);}
  writeCliEvent({command:"doctor",status:checks.some(c=>c.status==="UNVERIFIED")?"WARN":"OK",detail:checks.filter(c=>c.status==="UNVERIFIED").map(c=>c.label).join(", ")});
  if (checks.some(c => c.status === "UNVERIFIED")) process.exitCode = 1;
}

async function cmdSetup(json = false,verbose = false) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  const nodeOk = nodeMajor >= 20;

  const defaultWs = path.join(os.homedir(), "BridgeDevWorkspace");
  if (!fs.existsSync(defaultWs)) {
    try { fs.mkdirSync(defaultWs, { recursive: true }); } catch {}
  }
  const wsOk = fs.existsSync(defaultWs);

  const envFile = getEnvConfigPath();
  let mcpToken = process.env.MCP_TOKEN || "";
  let adminToken = process.env.ADMIN_TOKEN || "";
  let generatedTokens = false;

  if (!mcpToken || !adminToken) {
    if (!mcpToken) mcpToken = randomBytes(32).toString("hex");
    if (!adminToken) adminToken = randomBytes(32).toString("hex");
    generatedTokens = true;
    updateEnvVariable("MCP_TOKEN", mcpToken);
    updateEnvVariable("ADMIN_TOKEN", adminToken);
    updateEnvVariable("WORKSPACE_PATH", defaultWs);
    updateEnvVariable("PORT", "3000");
    updateEnvVariable("ADMIN_PORT", "3001");
    process.env.MCP_TOKEN = mcpToken;
    process.env.ADMIN_TOKEN = adminToken;
  }

  const service = await userServiceStatus();
  const funnel = getTailscaleEndpoint();
  const caps = platformCapabilities().capabilities;
  const roots = portableWorkspaceRoots();

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      node: { version: process.version, ok: nodeOk },
      workspace: { path: defaultWs, ok: wsOk, authorized_roots: roots },
      config: { path: envFile, tokens_configured: Boolean(mcpToken && adminToken), generated: generatedTokens },
      service: { installed: service.installed, state: service.state },
      funnel: funnel || null,
      capabilities: caps,
    }));
    return;
  }

  if(!json&&!verbose){
    console.log(`BridgeDev setup: ${nodeOk&&wsOk?"ready":"warnings"} · service ${service.installed?service.state:"not installed"}`);
    if(!nodeOk)console.warn("Warning: Node.js runtime is below supported version.");
    if(!wsOk)console.warn("Warning: default workspace unavailable.");
    writeCliEvent({command:"setup",status:nodeOk&&wsOk?"OK":"WARN"});
    return;
  }
  console.log("BridgeDev Guided Setup\n");
  console.log(`[${nodeOk ? "OK" : "WARN"}] Node.js runtime: ${process.version} (v20+ recommended)`);
  console.log(`[OK] Default runtime: ${getRuntimeMode()} (scoped policy)`);
  console.log(`[${wsOk ? "OK" : "WARN"}] Default workspace: ${defaultWs}`);
  console.log(`[OK] Extensions: ${path.join(defaultWs, ".bridge-dev", "extensions.json")}`);
  console.log(`[OK] Configuration: ${envFile} (mode 0600)`);
  console.log(`[OK] Tailscale Funnel: ${funnel ? funnel : "not detected (local loopback mode)"}`);
  console.log(`[INFO] Persistent service: ${service.installed ? service.unit + " (" + service.state + ")" : "not installed"}`);
  console.log("\nNext Steps:");
  if (!service.installed && process.platform === "linux") {
    console.log("  1. Install background service: bridge-dev service install --start");
  } else {
    console.log("  1. Start BridgeDev: bridge-dev start");
  }
  console.log("  2. Display connection instructions: bridge-dev access");
  console.log("  3. Manage authorized workspaces: bridge-dev workspace list");
  console.log("  4. Run system diagnostics: bridge-dev doctor");
}

function cmdLogin(args: string[] = []) {
  if (args.length && (args.length !== 1 || args[0] !== "--generate")) {
    console.error("Usage: bridge-dev login [--generate]");
    process.exitCode = 1;
    return;
  }
  if (args[0] === "--generate") {
    console.log("New MCP token (shown once; not installed or saved):");
    console.log(randomBytes(32).toString("hex"));
    console.log("Install the token in your private configuration through the operator-controlled workflow.");
    return;
  }
  const envFile = process.env.POLICYGATE_ENV_FILE || path.join(getActivePath("etc"), "service.env");
  let configured = Boolean(process.env.MCP_TOKEN);
  try {
    const content = fs.readFileSync(envFile, "utf8");
    configured = configured || /^MCP_TOKEN=.+$/m.test(content);
  } catch {}
  console.log(configured ? "MCP authentication token: configured (value hidden)" :
    "MCP token not confirmed from this user session.");
  console.log("Use 'bridge-dev login --generate' to create a new token; existing tokens are never printed.");
}


async function cmdUpdate(args: string[], json: boolean,verbose=false): Promise<void> {
  if (process.platform !== "linux") throw Error("UPDATE_SERVICE_UNSUPPORTED: managed Linux service required");
  if (args.some(x => !["--check", "--no-wait", "--standard-window"].includes(x)) ||
      (args.includes("--check") && args.includes("--no-wait")))
    throw Error("Usage: bridge-dev update [--check | --no-wait | --standard-window]");
  const status=await userServiceStatus();
  if (!status.installed) throw Error("UPDATE_SERVICE_NOT_INSTALLED: use bridge-dev service install");
  // Resolve main once; the existing updater independently validates exact SHA,
  // successful CI, artifact digest and rollback before changing the live service.
  const checked=spawnSync("gh",["api","repos/kmanisk/bridge-dev/commits/main","--jq",".sha"],{
    encoding:"utf8",timeout:16000,maxBuffer:8192,
  });
  const sha=String(checked.stdout||"").trim();
  if (checked.error || checked.status!==0 || !/^[a-f0-9]{40}$/.test(sha))
    throw Error("UPDATE_GITHUB_UNAVAILABLE: authenticate gh locally; no source fallback");
  if (args.includes("--check")) {
    const report={installed:true,current:status.current,latest_main:sha,update_available:status.current!==sha};
    writeCliEvent({command:"update --check",status:report.update_available?"AVAILABLE":"CURRENT",release:sha});
    if(json)console.log(JSON.stringify({ok:true,data:report}));
    else if(verbose)console.log(JSON.stringify(report,null,2));
    else console.log(report.update_available?`Update available: ${status.current?.slice(0,7)||"unknown"} → ${sha.slice(0,7)}`:`BridgeDev is up to date (${sha.slice(0,7)})`);
    return;
  }
  if (status.current===sha) {
    writeCliEvent({command:"update",status:"CURRENT",release:sha});
    console.log(json?JSON.stringify({ok:true,updated:false,current:sha}):`BridgeDev is up to date (${sha.slice(0,7)})`);
    return;
  }
  // --no-wait has no safe reauthorization point: it cannot be used with an
  // existing YOLO lease. Never silently re-enable root during acceptance.
  const signedBefore=getActiveMode();
  const initialMode=signedBefore.mode;
  // A time-limited YOLO lease must never be silently widened to the
  // indefinite --until-off lease. This one-command flow currently supports
  // only the independently authorized until-off lease.
  if (initialMode==="YOLO" && args.includes("--standard-window") &&
      signedBefore.detail!=="verified signed lease; until manually disabled")
    throw Error("UPDATE_TIMED_YOLO_UNSUPPORTED: use an explicit operator mode transition; refusing to extend a timed privilege lease");
  if(initialMode==="YOLO"){
    if(process.platform!=="linux")throw Error("UPDATE_SHADOW_LOCAL_LINUX_REQUIRED");
    try{assertLocalUpdateCgroup(fs.readFileSync("/proc/self/cgroup","utf8"));}
    catch(error){if((error as Error).message.startsWith("UPDATE_"))throw error;
      throw Error("UPDATE_LOCAL_SESSION_UNVERIFIED");}
  }
  // Fail before revoking an active YOLO lease when main has not passed CI,
  // its artifact is missing/corrupted, or staging fails. The later guarded
  // updater still independently validates the staged release and health.
  if (initialMode==="YOLO" && !args.includes("--no-wait")) {
    if (json || !process.stdin.isTTY || !process.stdout.isTTY || process.getuid?.()===0)
      throw Error("UPDATE_YOLO_LOCAL_TTY_REQUIRED: invoke from your unprivileged private local terminal");
    writeCliEvent({command:"update",status:"PREFLIGHT",release:sha});
    if(verbose)console.log("Preflight: verifying GitHub CI and staging the exact release before revoking YOLO.");
    const staged=await verifiedStagedRelease(sha,serviceRoot()) ||
      await stageVerifiedGithubRelease(sha,serviceRoot());
    if(staged.commit!==sha) throw Error("UPDATE_PREFLIGHT_SHA_MISMATCH");
  }
  // Signed YOLO stays active throughout the verified shadow transaction.
  // This path never calls the mode operator, requests a new lease, or executes
  // privileged-denial fixtures against the live gateway.
  if(initialMode==="YOLO"&&!args.includes("--standard-window")){
    const lease=snapshotUpdateLease();
    if(lease.mode!=="YOLO")throw Error("UPDATE_YOLO_LEASE_UNVERIFIED");
    if(!json)console.log(`Updating BridgeDev → ${sha.slice(0,7)} (isolated shadow)…`);
    const queued=await queueServiceOperation("update",sha,serviceRoot(),undefined,{shadowLease:lease});
    const id=String(queued.job_id||"");
    if(!/^[0-9a-f-]{36}$/.test(id))throw Error("UPDATE_SHADOW_JOB_RECEIPT_INVALID");
    if(queued.existing_job)throw Error("UPDATE_SHADOW_JOB_ALREADY_PENDING: "+id);
    const end=Date.now()+190000;
    let result:any;
    while(Date.now()<end){
      result=await jobResult(serviceRoot(),id);
      if(["SUCCESS","ROLLED_BACK","FAILED"].includes(result.status))break;
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    if(result?.status!=="SUCCESS")
      throw Error(`UPDATE_SHADOW_${result?.status||"UNFINISHED"}: job ${id}; ${String(result?.error||"inspect tracked journal").slice(0,170)}`);
    assertSameUpdateLease(lease,snapshotUpdateLease());
    const installed=await userServiceStatus();
    if(installed.active!==true||installed.current!==sha||installed.pointer_consistent!==true)
      throw Error("UPDATE_SHADOW_POST_CUTOVER_UNVERIFIED: inspect job "+id);
    writeCliEvent({command:"update",status:"SUCCESS",release:sha,job_id:id,detail:"lease unchanged"});
    if(json)console.log(JSON.stringify({ok:true,updated:true,commit:sha,mode:"YOLO",job_id:id}));
    else console.log(`BridgeDev updated: ${sha.slice(0,7)} · YOLO lease unchanged.`);
    return;
  }
  if (args.includes("--no-wait")) {
    if (initialMode!=="STANDARD")
      throw Error("UPDATE_DETACHED_REQUIRES_STANDARD: switch manually, or use plain bridge-dev update to handle YOLO safely");
    if(verbose)console.log("Queueing verified update from STANDARD; inspect the durable job ID.");
    await serviceCli(["service","update",sha,"--no-wait"],json,verbose);
    return;
  }
  if(!json)console.log(`Updating BridgeDev → ${sha.slice(0,7)}…`);
  writeCliEvent({command:"update",status:"STARTED",release:sha});
  const result=await coordinatedVerifiedUpdate({
    mode:()=>getActiveMode().mode,
    interactive:Boolean(!json && process.stdin.isTTY && process.stdout.isTTY && process.getuid?.()!==0),
    revokeYolo:async()=>runOperator(["mode","standard"]),
    deployAndWait:async()=>{
      await serviceCli(["service","update",sha],json,verbose,true);
      return !process.exitCode;
    },
    verifyRelease:async()=>{
      const current=await userServiceStatus();
      return current.installed===true && current.active===true &&
        current.current===sha && getActiveMode().mode==="STANDARD";
    },
    restoreYoloWithLocalConfirmation:async()=>runOperator(["yolo","--until-off"]),
    log:(message)=>{
      writeCliEvent({command:"update",status:"PROGRESS",release:sha,detail:message});
      if(verbose)console.log(message);
      else if(message.includes("unsuccessful")||message.includes("unfinished"))console.warn("Warning: update incomplete; remaining in STANDARD.");
    },
  });
  writeCliEvent({command:"update",status:"SUCCESS",release:sha,detail:result.final_mode});
  if(json)console.log(JSON.stringify({ok:true,updated:true,commit:sha,mode:result.final_mode}));
  else console.log(`BridgeDev updated: ${sha.slice(0,7)} · ${result.final_mode==="YOLO"?"YOLO restored (locally confirmed)":"STANDARD active"}.`);
}
async function cmdToken(args: string[]): Promise<void> {
  if (args[0]==="status" && args.length===1) {
    console.log(JSON.stringify(await inspectCredentialFile(),null,2)); return;
  }
  const kind=args[1];
  if(args[0]!=="rotate"||!["admin","mcp"].includes(kind)||
      args.some((a,i)=>i>1&&a!=="--restart"))
    throw Error("Usage: bridge-dev token status | token rotate <admin|mcp> [--restart]");
  if(!process.stdin.isTTY||!process.stdout.isTTY)
    throw Error("TOKEN_ROTATION_LOCAL_TTY_REQUIRED: run in your own terminal");
  const prompt=createInterface({input:process.stdin,output:process.stdout});
  try {
    const answer=await prompt.question("Rotate "+kind.toUpperCase()+
      " token? The previous .env will be backed up privately. [y/N] ");
    if(!/^(y|yes)$/i.test(answer.trim())){console.log("Token unchanged.");return;}
  } finally {prompt.close();}
  const changed=await rotateCredentialFile(credentialFilePath(),kind as "admin"|"mcp");
  console.log("Rotated "+kind.toUpperCase()+" token in "+changed.file+"; private backup: "+changed.backup);
  console.log("The backup retains old secrets; remove it only after verification.");
  if(args.includes("--restart")){
    const status=await userServiceStatus();
    if(status.installed){
      console.log("Restarting only bridge-dev.service; active MCP sessions may disconnect.");
      await serviceCli(["service","restart"],false);
    } else console.log("No installed service; restart the foreground gateway locally.");
  } else console.log("The running gateway still has the old token until it is restarted.");
  console.log(kind==="admin" ?
    "Re-pair local Admin with bridge-dev access after restart." :
    "MCP clients must use the new token-bearing connection URL after restart.");
}

function cmdHelp() {
  console.log("Persistent Linux service: bridge-dev service install|uninstall|status|start|stop|restart|enable|disable|logs|update <sha-or-tag>|rollback");
  console.log(`BridgeDev v${VERSION} — Self-hosted MCP Development Gateway`);
  console.log("Usage: bridge-dev [command] [options]\n");
  console.log("Core Commands:");
  console.log("  setup                 Guided first-time configuration and environment check");
  console.log("  start                 Start BridgeDev (uses systemd user service if installed)");
  console.log("  stop                  Stop BridgeDev service or running gateway");
  console.log("  restart               Restart BridgeDev service or running gateway");
  console.log("  status                Show gateway status, mode, sessions, and endpoint");
  console.log("  doctor                Run comprehensive diagnostics on environment health");
  console.log("  access                Display secure connection instructions (interactive only)");
  console.log("  dashboard             Open locally paired Admin dashboard (Linux local terminal only)");
  console.log("  update [--check]      One-command verified main update; temporarily STANDARD, then local YOLO reconfirmation");
  console.log("  update notices       Shown during interactive use; cached six hours, never auto-applied");
  console.log("  token status          Inspect protected token configuration, without values");
  console.log("  token rotate admin    Rotate Admin token with 0600 backup (--restart optional)");
  console.log("  token rotate mcp      Rotate MCP token with 0600 backup (--restart optional)");
  console.log("  monitor               Launch local TUI/scratchpad, or Admin dashboard");
  console.log("  monitor shortcut      Print custom keybind; optionally install XDG launcher");
  console.log("  workspace <action>    list / add <path> / remove <path> authorized workspaces");
  console.log("  mode <profile>        standard / yolo [--duration <min>] / yolo --off / status");
  console.log("  service <action>      install / uninstall / status / update / rollback / logs");
  console.log("\nCompatibility Aliases:");
  console.log("  mode read-write       Alias for 'mode standard' (normal scoped work)");
  console.log("  mode sudo             Alias for 'mode yolo' (ask [y/N] to enable Full System)");
  console.log("  mode sudo --duration 60  Optional time-limited Full System access");
  console.log("  mode sudo --off       Revoke root access and return to Read & Write");
  console.log("  project <subcommand>  Linux only: operator-controlled project mappings");
  console.log("  operator status|yolo|exec|logs|cleanup  Optional Linux host controller");
  console.log("  serve, start-server   Run the MCP server in foreground");
  console.log("\nExtensibility & Providers:");
  console.log("  add <source>          Discover, select and preview an extension");
  console.log("  mcp <action>          list/search/info/add/remove/enable/disable/update/test/tools/logs/status/import/export/migrate");
  console.log("  mcp migrate           Operator file migration: --config <file> [--dry-run]");
  console.log("  skills <action>       list/search/info/add/remove/enable/disable/update/validate/sources");
  console.log("  instructions <action> list/add/info/remove/enable/disable/update");
  console.log("  pack <action>         add/info/list/update/remove");
  console.log("  approve <id>          Apply exact reviewed proposal using independent operator credentials");
  console.log("  deploy plan|start|status|logs|verify|rollback|cleanup  Recoverable cutover jobs");
  console.log("\nFlags:");
  console.log("  --json                Output machine-readable JSON");
  console.log("  --verbose             Show full diagnostic details (default output is brief)");
  console.log("  CLI event log         "+cliLogFile());
  console.log("  help, --help, -h      Show this help menu\n");
  console.log("Security Modes:");
  console.log("  STANDARD     : Approved workspace files, Git, ordinary shell; no blanket sudo.");
  console.log("  FULL SYSTEM  : Root commands until switched off, or optional timed; local [y/N].");
  console.log("  Invalid protected authorization stays in the internal STRICT safety lock.");
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { args, json, verbose } = parseCliArguments(rawArgs);
  // A bounded, cached check happens only during interactive use. No worker,
  // interval, update, sudo, token disclosure, or machine-readable noise.
  const interactive = (args[0] || "status").toLowerCase();
  if (!json && process.stderr.isTTY &&
      process.env.BRIDGEDEV_UPDATE_NOTICE !== "off" &&
      ["status","doctor"].includes(interactive)) {
    try {
      const hint = formatUpdateHint(await checkLatestMain(runtimeVersion().commit));
      if (hint) process.stderr.write(hint + "\n");
    } catch { /* update availability never blocks an operator command */ }
  }
  if (await serviceCli(args, json, verbose)) return;
  if (await extensionCli(args, json, verbose)) return;
  if (await controllerCli(args, json, verbose)) return;
  if (json) {
    const log = console.log, lines: string[] = [];
    console.log = (...values: unknown[]) => { lines.push(values.map(String).join(" ")); };
    process.once("beforeExit", () => {
      console.log = log;
      log(JSON.stringify({ ok: !process.exitCode, command: args[0] || "status", output: lines }));
    });
  }
  const cmd = (args[0] || "").toLowerCase();

  switch (cmd) {
    case "":
    case "status":
      await cmdStatus(json,verbose);
      break;
    case "connect":
      await cmdConnect(args.includes("--show-token"));
      break;
    case "access":
      cmdAccess();
      break;
    case "dashboard":
      cmdDashboard();
      break;
    case "update":
      await cmdUpdate(args.slice(1),json,verbose);
      break;
    case "token":
      await cmdToken(args.slice(1));
      break;
    case "monitor":
      await monitorCli(args.slice(1));
      break;
    case "workspace":
      cmdWorkspace(args.slice(1), json);
      break;
    case "mode":
      await cmdMode(args.slice(1), json);
      break;
    case "project":
      if (args.length > 1 && ["list", "add", "remove", "rm"].includes(args[1]?.toLowerCase())) {
        cmdWorkspace(args.slice(1), json);
      } else {
        cmdProject(args.slice(1));
      }
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart();
      break;
    case "doctor":
      await cmdDoctor(json,verbose);
      break;
    case "setup":
      await cmdSetup(json,verbose);
      break;
    case "login":
      cmdLogin(args.slice(1));
      break;
    case "start":
      if ((await userServiceStatus()).installed) {
        const expose = args.includes("--funnel") || process.env.BRIDGEDEV_FUNNEL === "true" || process.env.BRIDGEDEV_TRANSPORT === "tailscale";
        const status = await startConfiguredService(undefined, expose ? enableTailscaleFunnel : undefined);
        writeCliEvent({command:"start",status:status?.active?"SUCCESS":"UNKNOWN"});
        console.log(json?JSON.stringify(status):verbose?JSON.stringify(status,null,2):"BridgeDev service started.");
        break;
      }
    case "serve":
    case "start-server": {
      const port = process.env.PORT || "3000";
      const wantFunnel = args.includes("--funnel") ||
        process.env.BRIDGEDEV_FUNNEL === "true" ||
        process.env.BRIDGEDEV_TRANSPORT === "tailscale";
      // Verify the local gateway is healthy before any explicitly requested exposure.
      const gateway = await import("./index.js");
      if (wantFunnel) {
        await gateway.waitForGatewayReady();
        enableTailscaleFunnel(Number(port));
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. Run bridge-dev help for usage.`);
  }
}

main().catch((err) => {
  const flags=parseCliArguments(process.argv.slice(2));
  const message=cliErrorMessage(err);
  const safeStack=String(redactAudit(err instanceof Error?err.stack||err.message:String(err)));
  const command=flags.args.slice(0,2).filter(x=>!x.startsWith("--")).join(" ")||"status";
  const logged=writeCliEvent({command,status:"FAILED",level:"error",code:message.split(":")[0],detail:message});
  console.error(flags.json?JSON.stringify({ok:false,error:flags.verbose?safeStack:message,code:"BRIDGEDEV_ERROR"}):
    flags.verbose?`Error: ${safeStack}`:`Error: ${message}${logged?` · details: ${cliLogFile()}`:""}`);
  process.exit(1);
});
