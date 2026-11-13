/**
 * Full verification suite for ChatGPT MCP readiness.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const mcpPort = 4200 + Math.floor(Math.random() * 200);
const adminPort = mcpPort + 1;
const adminToken = randomBytes(32).toString("hex");
const adminHeaders = { Authorization: "Bearer " + adminToken };

function runNode(script, env = {}) {
  const scriptPath = path.join(root, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exit ${code}`))));
  });
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc")], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", () => {
      const fallback = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
      fallback.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tsc exit ${code}`))));
  });
}

async function waitFor(url, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url, url.includes(":" + adminPort + "/") ? {headers:adminHeaders} : {});
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout ${url}`);
}

console.log("=== Build ===");
await runBuild();

const unitScripts = [
  "scripts/test-patch.mjs",
  "scripts/test-tools.mjs",
  "scripts/test-checkpoints.mjs",
  "scripts/test-activity-log.mjs",
  "scripts/test-project-memory.mjs",
  "scripts/test-tool-profile.mjs",
  "scripts/test-shell-persist.mjs",
  "scripts/test-phase1-safe-edit.mjs",
  "scripts/test-phase2-chezmoi.mjs",
  "scripts/test-system-enhancements.mjs",
  "scripts/test-policy-gateway.mjs",
  "scripts/test-bridge-dev-cli.mjs",
  "scripts/test-policy-upstream-readonly.mjs",
];

console.log("\n=== Unit tests ===");
for (const script of unitScripts) {
  console.log(`\n--- ${script} ---`);
  await runNode(script);
}

console.log("\n=== Integration (spawn server) ===");
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    ADMIN_TOKEN: adminToken,
    CHATGPT_TOOL_PROFILE: "slim",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout?.on("data", (d) => (serverLog += d));
server.stderr?.on("data", (d) => (serverLog += d));

try {
  const health = await waitFor(`http://127.0.0.1:${mcpPort}/health`);
  if (!health.instructions?.tool_profile) throw new Error("health missing instructions");
  console.log(`OK  health: profile=${health.instructions.tool_profile}, memory=${health.instructions.memory_files?.length ?? 0} files`);

  const deniedAdmin = await fetch(`http://127.0.0.1:${adminPort}/health`);
  if (deniedAdmin.status !== 401) throw new Error("admin health available without ADMIN_TOKEN");
  const admin = await waitFor(`http://127.0.0.1:${adminPort}/health`);
  if (!admin.instructions) throw new Error("admin health missing instructions");
  console.log("OK  admin health");

  const preview = await (await fetch(`http://127.0.0.1:${adminPort}/api/instructions/preview`,{headers:adminHeaders})).json();
  if (!preview.preview?.includes("Agent workflow")) throw new Error("instructions preview missing agent prompt");
  if (!preview.preview?.includes("Workstation-specific mandatory bootstrap") || !preview.preview.includes("system-philosophy.md")) {
    throw new Error("fresh-chat instructions missing canonical kmanisk/dots bootstrap and philosophy");
  }
  console.log(`OK  instructions preview ${preview.total_chars} chars including canonical Linux bootstrap`);

  // MCP session + tools/list count
  const initRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  if (!sid) throw new Error("no session id");

  const listRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listText = await listRes.text();
  const listJson = JSON.parse(listText);
  const tools = listJson?.result?.tools || [];
  const bytes = Buffer.byteLength(listText, "utf-8");
  console.log(`OK  tools/list: ${tools.length} tools, ${Math.round(bytes / 1024)}KB`);
  if (tools.length > 30) console.warn(`WARN tools/list has ${tools.length} tools — consider slim profile`);
  if (!tools.some((t) => t.name === "apply_patch")) throw new Error("apply_patch missing");
  for (const name of ["system_context", "system_inspect", "system_job", "chezmoi_inspect"]) {
    if (!tools.some((t) => t.name === name)) throw new Error(name + " missing from fresh MCP tools/list");
  }
  console.log("OK  fresh chat can discover context, inspection and jobs");

  const systemContextRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"system_context",arguments:{docs:["agents"],max_bytes_each:1000}}}),
  });
  const systemContextText = await systemContextRes.text();
  if (!systemContextRes.ok || !systemContextText.includes("AGENTS.md")) {
    throw new Error("fresh MCP system_context tool failed to read canonical AGENTS.md");
  }
  console.log("OK  MCP system_context accesses canonical docs");

  const inspectRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"system_inspect",arguments:{sections:["resources"]}}}),
  });
  const inspectText = await inspectRes.text();
  if (!inspectRes.ok || !inspectText.includes("total_bytes")) {
    throw new Error("fresh MCP system_inspect failed");
  }
  console.log("OK  MCP system_inspect provides structured resource data");

  process.env.PORT = String(mcpPort);
  await runNode("scripts/test-mcp-session.mjs", { PORT: String(mcpPort) });
  console.log("OK  test-mcp-session");
} finally {
  server.kill();
}

console.log("\n=== ALL TESTS PASSED ===");