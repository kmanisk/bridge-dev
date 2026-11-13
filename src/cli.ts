#!/usr/bin/env node

/**
 * BridgeDev CLI — Self-hosted MCP Development Gateway
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

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
  const canon = CANONICAL_DIRS[sub];
  const legacy = LEGACY_DIRS[sub];
  if (fs.existsSync(canon)) return canon;
  if (fs.existsSync(legacy)) return legacy;
  return canon;
}

function getServiceUnit(): string | null {
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
  const yoloPath = process.env.POLICYGATE_YOLO_LEASE || path.join(libDir, "yolo-lease.json");
  const modeFilePath = process.env.POLICYGATE_MODE_FILE || path.join(libDir, "mode.json");

  if (fs.existsSync(yoloPath)) {
    try {
      const lease = JSON.parse(fs.readFileSync(yoloPath, "utf8"));
      if (lease.expires_at && Date.now() < lease.expires_at) {
        const remainingMin = Math.round((lease.expires_at - Date.now()) / 60000);
        return {
          mode: "YOLO / FULL ACCESS",
          detail: `ACTIVE (${remainingMin}m remaining, expires: ${new Date(lease.expires_at).toLocaleTimeString()})`,
        };
      }
    } catch {}
  }

  if (fs.existsSync(modeFilePath)) {
    try {
      const m = JSON.parse(fs.readFileSync(modeFilePath, "utf8"));
      if (m.mode === "strict") {
        return {
          mode: "STRICT",
          detail: "Read-only default; operator approval required for mutations",
        };
      }
    } catch {}
  }

  return {
    mode: "STANDARD",
    detail: "Default: safe project dev; signed approval for sudo",
  };
}

function getTailscaleEndpoint(): string | null {
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
  const health = await fetchHealth(3000);
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
  console.log(`Service   : ${serviceStatus}${unit ? ` (PID: ${pid}, systemd: ${unit})` : ""}`);
  console.log(`Status    : ${health ? "connected" : "offline"}${health ? ` (Profile: ${profile}, Active Sessions: ${sessions})` : ""}`);
  console.log(`Mode      : ${modeInfo.mode} (${modeInfo.detail})`);
  console.log(`Project   : ${workspace} (${projects.length} mapped project${projects.length === 1 ? "" : "s"})`);
  console.log(`Endpoint  : ${endpointStr}`);
  console.log("Next step : Run 'bridge-dev help' for commands or 'bridge-dev doctor' for diagnostics.");
}

async function cmdConnect(showToken = false) {
  const funnel = getTailscaleEndpoint();
  const baseUrl = funnel || "http://127.0.0.1:3000";

  let token = "[Configured in .env / service.env]";
  if (showToken) {
    const envFile = process.env.POLICYGATE_ENV_FILE || path.join(getActivePath("etc"), "service.env");
    if (fs.existsSync(envFile)) {
      try {
        const text = fs.readFileSync(envFile, "utf8");
        const m = text.match(/^MCP_TOKEN=(.+)$/m);
        if (m) token = m[1].trim();
      } catch {}
    } else if (process.env.MCP_TOKEN) {
      token = process.env.MCP_TOKEN;
    }
  }

  console.log("BridgeDev Connection Configuration");
  console.log("==================================");
  console.log(`Protocol      : Streamable HTTP MCP`);
  console.log(`Base URL      : ${baseUrl}`);
  console.log(`Local URL     : http://127.0.0.1:3000`);
  console.log(`MCP Endpoint  : ${baseUrl}/mcp`);
  console.log(`Admin UI      : http://127.0.0.1:3001 (localhost only)`);
  console.log(`Authentication: Bearer Token`);
  console.log(`Token         : ${token}`);
  console.log("");
  console.log("ChatGPT Setup:");
  console.log("1. In ChatGPT, open Settings -> Connected Apps -> Add MCP Server.");
  console.log(`2. URL: ${baseUrl}/mcp`);
  console.log(`3. Auth: Bearer Token (run 'bridge-dev connect --show-token' to reveal).`);
  console.log("");
  console.log("Codex / Claude Code Setup (mcpServers configuration):");
  console.log(JSON.stringify({
    mcpServers: {
      "bridge-dev": {
        url: `${baseUrl}/mcp`,
        headers: { Authorization: `Bearer ${showToken ? token : "<MCP_TOKEN>"}` },
      },
    },
  }, null, 2));
}

function cmdMode(args: string[]) {
  const sub = args[0]?.toLowerCase();
  const libDir = getActivePath("lib");
  const modeFilePath = path.join(libDir, "mode.json");
  const yoloLeasePath = path.join(libDir, "yolo-lease.json");

  if (!sub) {
    const cur = getActiveMode();
    console.log(`Active Security Mode: ${cur.mode}`);
    console.log(`Details             : ${cur.detail}`);
    console.log("\nUsage: bridge-dev mode <strict | standard | yolo> [--duration <min> | --off]");
    return;
  }

  if (sub === "standard") {
    if (fs.existsSync(yoloLeasePath)) {
      try {
        fs.unlinkSync(yoloLeasePath);
      } catch (err: any) {
        console.error(`Failed to remove YOLO lease: ${err.message} (may require sudo)`);
        process.exit(1);
      }
    }
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(modeFilePath, JSON.stringify({ mode: "standard", updated_at: Date.now() }, null, 2) + "\n");
    console.log("Mode switched to STANDARD (safe project development; signed approval for sudo).");
    return;
  }

  if (sub === "strict") {
    if (fs.existsSync(yoloLeasePath)) {
      try {
        fs.unlinkSync(yoloLeasePath);
      } catch (err: any) {
        console.error(`Failed to remove YOLO lease: ${err.message} (may require sudo)`);
        process.exit(1);
      }
    }
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(modeFilePath, JSON.stringify({ mode: "strict", updated_at: Date.now() }, null, 2) + "\n");
    console.log("Mode switched to STRICT (read-only default; mutations require operator approval).");
    return;
  }

  if (sub === "yolo") {
    // Dispatch to policygate-operator for operator signature and confirmation
    const optDir = getActivePath("opt");
    const script = path.join(optDir, "scripts/policygate-operator.mjs");
    if (!fs.existsSync(script)) {
      console.error(`Operator script not found at ${script}`);
      process.exit(1);
    }
    const proc = spawn("sudo", ["node", script, "yolo", ...args.slice(1)], { stdio: "inherit" });
    proc.on("exit", (code) => process.exit(code || 0));
    return;
  }

  console.error(`Unknown mode: ${sub}. Allowed values: strict, standard, yolo.`);
  process.exit(1);
}

function cmdProject(args: string[]) {
  const sub = args[0]?.toLowerCase();
  const srvDir = getActivePath("srv");
  const projDir = path.join(srvDir, "projects");

  if (!sub || sub === "list") {
    console.log(`Mapped Projects in ${projDir}:`);
    const projects = getMappedProjects();
    if (projects.length === 0) {
      console.log("  (None currently mapped)");
    } else {
      for (const p of projects) {
        const full = path.join(projDir, p);
        let src = "(bind mount)";
        try {
          src = execSync(`findmnt -n -o SOURCE ${full} 2>/dev/null`, { encoding: "utf8" }).trim() || src;
        } catch {}
        console.log(`  - ${p} -> ${src}`);
      }
    }
    return;
  }

  if (sub === "map") {
    const target = args[1];
    if (!target) {
      console.error("Usage: bridge-dev project map <path-or-project-name>");
      process.exit(1);
    }
    let resolved = path.resolve(target);
    if (!fs.existsSync(resolved) && process.env.HOME) {
      const alt = path.join(process.env.HOME, "Projects", target);
      if (fs.existsSync(alt)) resolved = alt;
    }
    if (!fs.existsSync(resolved)) {
      console.error(`Project path does not exist: ${resolved}`);
      process.exit(1);
    }

    const baseName = path.basename(resolved);
    const mountPoint = path.join(projDir, baseName);

    console.log(`Configuring project workspace for ${baseName} (${resolved})...`);
    try {
      execSync(`sudo setfacl -R -m u:localcoder:rwx "${resolved}" 2>/dev/null || sudo setfacl -R -m u:bridgedev:rwx "${resolved}" 2>/dev/null || true`);
      execSync(`sudo mkdir -p "${mountPoint}"`);
      execSync(`mountpoint -q "${mountPoint}" || sudo mount --bind "${resolved}" "${mountPoint}"`);
      console.log(`Project mapped successfully at ${mountPoint}`);
    } catch (err: any) {
      console.error(`Failed to map project: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "unmap") {
    const name = args[1];
    if (!name) {
      console.error("Usage: bridge-dev project unmap <project-name>");
      process.exit(1);
    }
    const mountPoint = path.join(projDir, name);
    try {
      execSync(`mountpoint -q "${mountPoint}" && sudo umount "${mountPoint}" || true`);
      if (fs.existsSync(mountPoint)) {
        execSync(`sudo rmdir "${mountPoint}" 2>/dev/null || true`);
      }
      console.log(`Project ${name} unmapped.`);
    } catch (err: any) {
      console.error(`Failed to unmap project: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.error("Usage: bridge-dev project <list | map <path> | unmap <name>>");
  process.exit(1);
}

function cmdStop() {
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
  const unit = getServiceUnit() || "chatgpt-local-coder-policygate.service";
  console.log(`Restarting ${unit}...`);
  try {
    execSync(`sudo systemctl restart ${unit}`);
    let recovered = false;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const health = await fetchHealth(3000);
      if (health) {
        recovered = true;
        break;
      }
    }
    if (recovered) {
      console.log("Service restarted successfully and healthy.");
    } else {
      console.log("Service restarted. Note: listener on port 3000 did not respond immediately.");
    }
  } catch (err: any) {
    console.error(`Failed to restart service: ${err.message}`);
    process.exit(1);
  }
}

async function cmdDoctor() {
  console.log("BridgeDev System Diagnostic (Doctor)");
  console.log("====================================");

  const checks: Array<{ name: string; ok: boolean; info: string }> = [];

  // 1. Node.js runtime
  const nodeVer = process.version;
  const major = parseInt(nodeVer.replace(/^v/, "").split(".")[0], 10);
  checks.push({
    name: "Node.js Runtime",
    ok: major >= 20,
    info: `${nodeVer} (${major >= 20 ? "supported" : "requires >= 20"})`,
  });

  // 2. Service daemon
  const unit = getServiceUnit();
  checks.push({
    name: "Systemd Service",
    ok: unit !== null,
    info: unit ? `active (${unit})` : "inactive / not found",
  });

  // 3. MCP Listener (:3000)
  const health = await fetchHealth(3000);
  checks.push({
    name: "MCP Listener (:3000)",
    ok: health !== null,
    info: health ? `OK (sessions: ${health.activeSessions ?? 0}, profile: ${health.instructions?.tool_profile || "slim"})` : "connection refused",
  });

  // 4. Admin UI Listener (:3001)
  const adminHealth = await new Promise<boolean>((resolve) => {
    const req = http.get("http://127.0.0.1:3001/health", { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 401);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
  checks.push({
    name: "Admin Listener (:3001)",
    ok: adminHealth,
    info: adminHealth ? "OK (localhost guard active)" : "inactive",
  });

  // 5. Tailscale Funnel
  const funnel = getTailscaleEndpoint();
  checks.push({
    name: "Tailscale Funnel",
    ok: funnel !== null,
    info: funnel ? `Active (${funnel})` : "no active funnel detected",
  });

  // 6. Audit Ledger
  const logDir = getActivePath("log");
  const auditFile = path.join(logDir, "audit.jsonl");
  let auditInfo = "missing";
  let auditOk = false;
  if (fs.existsSync(auditFile)) {
    try {
      const stats = fs.statSync(auditFile);
      auditOk = true;
      auditInfo = `present (${stats.size} bytes)`;
    } catch {
      auditInfo = "permission denied";
    }
  } else {
    try {
      execSync(`sudo -n test -f "${auditFile}" 2>/dev/null`);
      auditOk = true;
      const count = execSync(`sudo -n wc -l "${auditFile}" 2>/dev/null`, { encoding: "utf8" }).trim().split(" ")[0];
      auditInfo = `present (${count} entries, append-only protected)`;
    } catch {}
  }
  checks.push({
    name: "Audit Ledger",
    ok: auditOk,
    info: auditInfo,
  });

  // 7. Operator Keypair
  const etcDir = getActivePath("etc");
  const pubKey = path.join(etcDir, "operator-public.pem");
  const privKey = path.join(etcDir, "operator-private.pem");
  let keyOk = fs.existsSync(pubKey);
  let keyInfo = keyOk ? "public key present" : "public key missing";
  if (!keyOk) {
    try {
      execSync(`sudo -n test -f "${pubKey}" 2>/dev/null`);
      keyOk = true;
      keyInfo = "public key present (root-owned)";
    } catch {}
  }
  checks.push({
    name: "Operator Keypair",
    ok: keyOk,
    info: keyInfo,
  });

  // 8. Active Mode
  const mode = getActiveMode();
  checks.push({
    name: "Security Mode",
    ok: true,
    info: `${mode.mode} (${mode.detail})`,
  });

  for (const c of checks) {
    const badge = c.ok ? "\x1b[32m[OK]\x1b[0m  " : "\x1b[31m[FAIL]\x1b[0m";
    console.log(`${badge} ${c.name.padEnd(24)}: ${c.info}`);
  }
}

function cmdSetup() {
  console.log("BridgeDev Setup & Verification");
  console.log("==============================");
  console.log(`Checking directories under /opt, /etc, /var/lib, /var/log, /srv...`);
  for (const [key, dir] of Object.entries(CANONICAL_DIRS)) {
    const exists = fs.existsSync(dir);
    console.log(`  ${key.toUpperCase().padEnd(4)}: ${dir} (${exists ? "exists" : "not created yet"})`);
  }
  console.log("\nTo deploy as a restricted systemd service, see:");
  console.log("  deployment/bridge-dev-policygate.service.example");
  console.log("  docs/POLICY_GATEWAY.md");
}

function cmdLogin() {
  const envFile = path.join(getActivePath("etc"), "service.env");
  let token = "";
  if (fs.existsSync(envFile)) {
    try {
      const text = fs.readFileSync(envFile, "utf8");
      const m = text.match(/^MCP_TOKEN=(.+)$/m);
      if (m) token = m[1].trim();
    } catch {}
  }
  if (!token && process.env.MCP_TOKEN) {
    token = process.env.MCP_TOKEN;
  }

  if (token) {
    console.log("Authentication token configured:");
    console.log(`  Token: ${token}`);
  } else {
    const generated = randomBytes(32).toString("hex");
    console.log("No MCP_TOKEN currently found. Recommended new secret token:");
    console.log(`  ${generated}`);
    console.log("\nSet this in your .env or service.env file:");
    console.log(`  MCP_TOKEN=${generated}`);
  }
}

function cmdHelp() {
  console.log(`BridgeDev v${VERSION} — Self-hosted MCP Development Gateway`);
  console.log("Usage: bridge-dev [command] [options]\n");
  console.log("Commands:");
  console.log("  (no args)             Display compact status report");
  console.log("  status                Detailed connection, service and project status");
  console.log("  connect               Show MCP client connection instructions (--show-token)");
  console.log("  mode [name]           View or switch security mode (strict, standard, yolo)");
  console.log("  project <subcommand>  Manage project workspaces (list, map <path>, unmap <name>)");
  console.log("  doctor                Run system diagnostics and verify environment health");
  console.log("  setup                 Verify directory paths and installation prerequisites");
  console.log("  login                 Inspect or generate authentication tokens");
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
      cmdLogin();
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
