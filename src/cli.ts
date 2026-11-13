#!/usr/bin/env node

/**
 * BridgeDev CLI — Self-hosted MCP Development Gateway
 */

import { execSync, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { formatMcpEndpoint, inspectLocalMode, resolveProjectDirectory, validateProjectName, verifyAuditProof } from "./lib/cli-security.js";
import { platformCapabilities, getRuntimeMode, portableStateDir, portableWorkspace } from "./lib/runtime.js";

const VERSION = "2.0.0";

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
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
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
  const libDir = getActivePath("lib");
  const etcDir = getActivePath("etc");
  return inspectLocalMode({
    stateDir: libDir,
    publicKeyFile: process.env.POLICYGATE_APPROVAL_PUBLIC_KEY || path.join(etcDir, "operator-public.pem"),
    leaseFile: process.env.POLICYGATE_YOLO_LEASE || path.join(libDir, "yolo-lease.json"),
    modeFile: process.env.POLICYGATE_MODE_FILE || path.join(libDir, "mode.json"),
  });
}

function getTailscaleEndpoint(): string | null {
  if (getRuntimeMode() === "portable") return null;
  try {
    const out = execSync("tailscale funnel status 2>/dev/null", { encoding: "utf8" });
    const match = out.match(/https:\/\/[a-zA-Z0-9.-]+\.ts\.net/);
    if (match) return match[0];
  } catch {}
  return null;
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

async function cmdStatus() {
  const unit = getServiceUnit();
  const health = await fetchHealth(Number(process.env.PORT || 3000));
  const modeInfo = getActiveMode();
  const funnel = getTailscaleEndpoint();
  const projects = getMappedProjects();

  let serviceStatus = "stopped";
  let pid = "N/A";
  if (unit) {
    serviceStatus = "active";
    try {
      pid = execSync(`systemctl show -p MainPID --value ${unit} 2>/dev/null`, { encoding: "utf8" }).trim();
    } catch {}
  }

  const endpointStr = funnel
    ? `${funnel} -> http://127.0.0.1:3000`
    : "http://127.0.0.1:3000 (local only)";

  const profile = health?.instructions?.tool_profile || "slim";
  const sessions = health?.activeSessions ?? 0;
  const workspace = health?.workspace || path.join(getActivePath("srv"), "workspace");

  console.log(`BridgeDev v${VERSION}`);
  console.log(`Runtime   : ${health?.runtimeMode || (unit ? "managed system service" : getRuntimeMode())} on ${process.platform}`);
  console.log(`Service   : ${unit ? serviceStatus + ` (PID: ${pid}, systemd: ${unit})` : health ? "foreground server reachable" : "not detected"}`);
  console.log(`Status    : ${health ? "connected" : "offline"}${health ? ` (Profile: ${profile}, Active Sessions: ${sessions})` : ""}`);
  console.log(`Mode      : ${modeInfo.mode} (${modeInfo.detail})`);
  console.log(`Project   : ${workspace} (${projects.length} mapped project${projects.length === 1 ? "" : "s"})`);
  console.log(`Endpoint  : ${endpointStr}`);
  console.log("Next step : Run 'bridge-dev help' for commands or 'bridge-dev doctor' for diagnostics.");
}

async function cmdConnect(showToken = false) {
  const funnel = getTailscaleEndpoint();
  const baseUrl = process.env.BRIDGEDEV_PUBLIC_URL || funnel || `http://127.0.0.1:${process.env.PORT || 3000}`;
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
  console.log("Auth     : Token in URL path (not an Authorization: Bearer header)");
  console.log("Admin UI : http://127.0.0.1:3001 (local only, separate admin token)");
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

function runOperator(args: string[]): void {
  if (process.platform !== "linux") {
    console.error("Signed operator mode control requires the hardened Linux installation.");
    process.exitCode = 1;
    return;
  }
  const script = path.join(getActivePath("opt"), "scripts", "policygate-operator.mjs");
  if (!fs.existsSync(script)) {
    console.error("Operator script not installed: " + script);
    process.exitCode = 1;
    return;
  }
  // The operator script independently requires real root UID and an interactive terminal.
  const run = spawnSync("sudo", ["--", process.execPath, script, ...args], {stdio:"inherit"});
  if (run.error || run.status !== 0) {
    console.error("Operator authorization failed. Use an independent local root terminal.");
    process.exitCode = run.status || 1;
  }
}

function cmdMode(args: string[]) {
  const target = args[0]?.toLowerCase();
  if (!target) {
    const reading = getActiveMode();
    console.log("Mode: " + reading.mode + " (" + reading.detail + ")");
    if (reading.mode === "UNKNOWN") {
      console.log("For an authoritative status use the installed operator's status command.");
    }
    return;
  }
  if (target === "strict" || target === "standard") {
    runOperator(["mode", target]);
    return;
  }
  if (target === "yolo") {
    runOperator(["yolo", ...args.slice(1)]);
    return;
  }
  console.error("Usage: bridge-dev mode [strict | standard | yolo --duration <minutes> | yolo --off]");
  process.exitCode = 1;
}

function cmdProject(args: string[]) {
  const action = args[0]?.toLowerCase() || "list";
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

function cmdStop() {
  if (getRuntimeMode() === "portable") throw new Error("Foreground gateway: stop it with Ctrl-C; managed services require explicit managed configuration.");
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
  if (getRuntimeMode() === "portable") throw new Error("Foreground gateway: restart the serve command; managed services require explicit managed configuration.");
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

async function cmdDoctor() {
  console.log("BridgeDev doctor");
  const checks: Array<{label:string;status:"OK"|"UNVERIFIED"|"INFO";detail:string}> = [];
  const add = (label:string,status:"OK"|"UNVERIFIED"|"INFO",detail:string) => checks.push({label,status,detail});
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0]||"0",10);
  add("Node runtime",nodeMajor>=20?"OK":"UNVERIFIED",process.version);
  if (process.platform === "linux") {
    const unit=getServiceUnit();
    add("systemd",unit?"OK":"UNVERIFIED",unit||"no running BridgeDev system service found");
  } else {
    add("systemd","INFO","not available on "+process.platform+"; foreground source build only");
  }
  const health=await fetchHealth(Number(process.env.PORT || 3000));
  add("MCP endpoint",health?"OK":"UNVERIFIED",health?"HTTP 200, sessions: "+(health.activeSessions??0):"port 3000 unavailable");
  if (process.platform==="linux") {
    const admin=await new Promise<number>((resolve)=>{
      const req=http.get("http://127.0.0.1:3001/health",{timeout:1500},res=>{res.resume();resolve(res.statusCode||0);});
      req.on("error",()=>resolve(0));req.on("timeout",()=>{req.destroy();resolve(0);});
    });
    add("Admin endpoint",admin===401?"OK":admin===200?"UNVERIFIED":"UNVERIFIED",
      admin===401?"reachable, unauthenticated request denied":admin===200?"reachable, but unauthenticated health allowed":"not reachable");
    const funnel=getTailscaleEndpoint();
    add("Public tunnel","INFO",funnel||"not configured");
    const log=path.join(getActivePath("log"),"audit.jsonl");
    const anchor=process.env.POLICYGATE_AUDIT_ANCHOR_FILE||
      path.join(getActivePath("etc"),"audit-anchor.json");
    try {
      const proof=verifyAuditProof(log,anchor);
      const st=fs.statSync(log),ast=fs.statSync(anchor);
      const flags=execFileSync("lsattr",["-d","--",log],{encoding:"utf8",timeout:3000}).trim().split(/\s+/)[0]||"";
      if (st.uid!==0 || (st.mode&0o777)!==0o660 || ast.uid!==0 || !flags.includes("a"))
        throw new Error("owner, permissions, trusted anchor or append-only flag invalid");
      add("Audit ledger","OK",proof.entries+" chained entries, "+proof.anchoredEntries+" anchored; append-only verified");
    } catch (e) {
      add("Audit ledger","UNVERIFIED","chain/anchor/append-only not verified: "+
        (e instanceof Error?e.message:String(e))+"; run doctor as an independent root operator");
    }
    const key=path.join(getActivePath("etc"),"operator-public.pem");
    try {
      const st=fs.statSync(key);
      add("Operator public key",st.isFile()&&st.uid===0?"OK":"UNVERIFIED",
        st.isFile()&&st.uid===0?"present, root-owned (private key not accessed)":"invalid ownership or type");
    } catch { add("Operator public key","UNVERIFIED","not readable; use independent operator inspection"); }
    const mode=getActiveMode();
    add("Security mode",mode.mode!=="UNKNOWN"?"OK":"UNVERIFIED",mode.mode+" — "+mode.detail);
  } else {
    add("Hardened policy checks","INFO","not verified outside Linux systemd");
  }
  for (const c of checks) {
    console.log("[" + c.status + "] " + c.label.padEnd(22) + ": " + c.detail);
  }
  if (checks.some(c=>c.status==="UNVERIFIED")) process.exitCode=1;
}

function cmdSetup() {
  console.log("BridgeDev setup check");
  console.log("Platform: "+process.platform+" / "+os.arch());
  console.log("Default runtime: "+getRuntimeMode());
  const caps=platformCapabilities().capabilities;
  console.log("Core modules: "+Object.entries(caps).filter(([,v])=>v==="available").map(([k])=>k).join(", "));
  console.log("Optional modules: "+Object.entries(caps).filter(([,v])=>v==="optional").map(([k])=>k).join(", "));
  const root=process.env.WORKSPACE_PATH?.split(";")[0]||process.cwd();
  console.log("Workspace: "+path.resolve(root));
  console.log("Extensions: "+path.join(path.resolve(root),".bridge-dev","extensions.json"));
  console.log("MCP providers: disabled until explicitly configured in the workspace or via MCP_UPSTREAM_CONFIG");
  if(process.platform!=="linux")console.log("Hardened Linux systemd/privilege broker unavailable on this platform.");
  console.log("Next: configure MCP_TOKEN in a private .env file, then run 'bridge-dev serve'.");
}

function cmdLogin(args: string[] = []) {
  if (args.length && (args.length!==1 || args[0]!=="--generate")) {
    console.error("Usage: bridge-dev login [--generate]");
    process.exitCode=1;
    return;
  }
  if (args[0]==="--generate") {
    console.log("New MCP token (shown once; not installed or saved):");
    console.log(randomBytes(32).toString("hex"));
    console.log("Install the token in your private configuration through the operator-controlled workflow.");
    return;
  }
  const envFile=process.env.POLICYGATE_ENV_FILE||path.join(getActivePath("etc"),"service.env");
  let configured=Boolean(process.env.MCP_TOKEN);
  try {
    const content=fs.readFileSync(envFile,"utf8");
    configured = configured || /^MCP_TOKEN=.+$/m.test(content);
  } catch {}
  console.log(configured?"MCP authentication token: configured (value hidden)":
    "MCP token not confirmed from this user session.");
  console.log("Use 'bridge-dev login --generate' to create a new token; existing tokens are never printed.");
}

function cmdHelp() {
  console.log(`BridgeDev v${VERSION} — Self-hosted MCP Development Gateway`);
  console.log("Usage: bridge-dev [command] [options]\n");
  console.log("Commands:");
  console.log("  (no args)             Display compact status report");
  console.log("  status                Detailed connection, service and project status");
  console.log("  connect               Show token-in-URL MCP connection instructions (--show-token)");
  console.log("  mode [name]           Operator-controlled mode (strict, standard, yolo)");
  console.log("  project <subcommand>  Linux only: operator-controlled project mappings");
  console.log("  doctor                Run system diagnostics and verify environment health");
  console.log("  setup                 Verify directory paths and installation prerequisites");
  console.log("  login [--generate]    Check authentication status; generate a new token explicitly");
  console.log("  restart               Restart the running BridgeDev service");
  console.log("  stop                  Stop the running BridgeDev service");
  console.log("  serve                 Run the MCP server in foreground");
  console.log("  help, --help          Show this help menu\n");
  console.log("Security Modes:");
  console.log("  STRICT    : Read-only inspection; mutations require signed operator approval.");
  console.log("  STANDARD  : Default everyday dev; routine project edits permitted; sudo gated.");
  console.log("  YOLO      : Time-limited, root-operator-signed lease for maintenance.");
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || "").toLowerCase();

  switch (cmd) {
    case "":
      await cmdStatus();
      break;
    case "status":
      await cmdStatus();
      break;
    case "connect":
      await cmdConnect(args.includes("--show-token"));
      break;
    case "mode":
      cmdMode(args.slice(1));
      break;
    case "project":
      cmdProject(args.slice(1));
      break;
    case "stop":
      cmdStop();
      break;
    case "restart":
      await cmdRestart();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "setup":
      cmdSetup();
      break;
    case "login":
      cmdLogin(args.slice(1));
      break;
    case "serve":
    case "start-server":
      await import("./index.js");
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}\nRun 'bridge-dev help' for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
