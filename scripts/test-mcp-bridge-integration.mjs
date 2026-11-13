/**
 * Integration: hub server + mock upstream + meta tools + proxy tool.
 * Self-contained — spawns child processes on random ports.
 */
import os from "node:os";
import {fixturePorts} from "./test-ports.mjs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(),"bridge-legacy-integration-"));

const [mcpPort,adminPort,mockPort]=await fixturePorts(3);
const adminToken = randomBytes(32).toString("hex"),mcpToken=randomBytes(32).toString("hex");
const adminHeaders = { Authorization: "Bearer " + adminToken };
const tmpDir = path.join(scratch, `run-${mcpPort}`);

function spawnNode(script, env = {}) {
  return spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitFor(url, timeoutMs = 20000) {
  const start = Date.now();
  let lastErr = "unknown";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, url.includes(":" + adminPort + "/") ? {headers:adminHeaders} : {});
      const text = await res.text();
      if (res.ok) {
        return text ? JSON.parse(text) : {};
      }
      lastErr = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout ${url} (${lastErr})`);
}

async function mcpPost(base, body, sessionId, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization:"Bearer "+mcpToken,
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`invalid JSON from ${base}/mcp: ${text.slice(0, 300)}`);
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function callTool(base, sessionId, name, args = {}) {
  const { status, json } = await mcpPost(
    base,
    { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
    sessionId
  );
  if (status !== 200) throw new Error(`tools/call ${name} HTTP ${status}: ${JSON.stringify(json)}`);
  return json;
}

await fs.mkdir(tmpDir, { recursive: true });

const configPath = path.join(tmpDir, "mcp-upstream.json");
await fs.writeFile(
  configPath,
  JSON.stringify(
    {
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          allow_private_network:true,
          url: `http://127.0.0.1:${mockPort}/mcp`,
          expose: "meta_only",
          tools: [],
          tool_prefix: "mockhttp",
        },
      ],
    },
    null,
    2
  ),
  "utf-8"
);

const mockHttp = spawnNode(path.join(root, "scripts/mock-http-mcp.mjs"), { MOCK_HTTP_MCP_PORT: String(mockPort) });
const hub = spawnNode(path.join(root, "dist/index.js"), {
  PORT: String(mcpPort),
  ADMIN_PORT: String(adminPort),
  ADMIN_TOKEN: adminToken,
  MCP_TOKEN:mcpToken,
  CHATGPT_TOOL_PROFILE: "full",
  MCP_UPSTREAM_CONFIG: configPath,
  WORKSPACE_PATH: process.env.WORKSPACE_PATH,
});

let hubLog = "";
let mockLog = "";
hub.stdout.on("data", (d) => (hubLog += d.toString()));
hub.stderr.on("data", (d) => (hubLog += d.toString()));
mockHttp.stdout.on("data", (d) => (mockLog += d.toString()));
mockHttp.stderr.on("data", (d) => (mockLog += d.toString()));
hub.on("exit", (code) => {
  hubLog += `\n[hub exit ${code}]`;
});

const logLines = [];
function log(msg) {
  logLines.push(msg);
  console.log(msg);
}

try {
  log(`ports mcp=${mcpPort} admin=${adminPort} mock=${mockPort}`);
  await waitFor(`http://127.0.0.1:${mockPort}/health`);
  await waitFor(`http://127.0.0.1:${mcpPort}/health`);
  const anonymousAdmin = await fetch(`http://127.0.0.1:${adminPort}/health`);
  if (anonymousAdmin.status !== 401) throw Error("admin health exposed without token");
  await waitFor(`http://127.0.0.1:${adminPort}/health`);

  await fetch(`http://127.0.0.1:${adminPort}/api/extensions/provider-test`,{method:"POST",headers:{...adminHeaders,"Content-Type":"application/json"},body:JSON.stringify({name:"mockhttp"})});
  const init = await mcpPost(
    `http://127.0.0.1:${mcpPort}`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "bridge-integration", version: "1.0.0" },
      },
    },
    null
  );
  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing session id");

  await mcpPost(
    `http://127.0.0.1:${mcpPort}`,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );

  const servers = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mcp_servers", {});
  const serversPayload = JSON.parse(servers.result.content[0].text);
  if (!serversPayload.ok || serversPayload.data.count < 1) throw new Error(JSON.stringify(serversPayload));

  const tools = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mcp_tools", { server_id: "mockhttp" });
  let toolsPayload;
  try { toolsPayload = JSON.parse(tools.result.content[0].text); }
  catch { throw new Error("mcp_tools returned non-JSON error: " + String(tools.result.content[0].text).slice(0,500)); }
  // The earlier authenticated admin /health call can deliberately warm the
  // upstream cache. This R-class tool must only read it, never initiate a
  // connection. The independent stdio marker regression proves no spawn.
  if (!toolsPayload.ok || toolsPayload.data.count < 1) throw new Error("expected tools cached by authenticated admin health: "+JSON.stringify(toolsPayload));
  log("read-only upstream discovery uses authenticated-admin-warmed cache");

  // The policy gateway classifies mcp_call as X and requires canonical
  // context plus a separate root-signed approval. Never bypass that in CI.
  const callArgs = { server_id: "mockhttp", tool: "add", arguments: { a: 4, b: 6 } };
  const refusedBeforeContext = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mcp_call", callArgs);
  const deniedText = JSON.stringify(refusedBeforeContext);
  if (!deniedText.includes("POLICYGATE_CONTEXT_REQUIRED")) {
    throw new Error("mcp_call did not require context: " + deniedText.slice(0,500));
  }
  const bootstrap = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "system_context", {
    docs: ["agents", "current_state"]
  });
  if (bootstrap.result?.isError) throw new Error("system_context bootstrap failed");
  const unsigned = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mcp_call", callArgs);
  if (!JSON.stringify(unsigned).includes("POLICYGATE_APPROVAL_REQUIRED")) {
    throw new Error("mcp_call executed without a signature");
  }
  const callPayload = { context_refused:true, operator_signature_required:true };
  log("mcp_call refuses execution before context and requires operator signature");

  const listBefore = await mcpPost(
    `http://127.0.0.1:${mcpPort}`,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  const toolNamesBefore = listBefore.json.result.tools.map((t) => t.name);
  if (toolNamesBefore.includes("mockhttp__add")) {
    throw new Error(`proxy should not exist before allowlist: ${toolNamesBefore.join(",")}`);
  }
  log(`tools/list before allowlist: mockhttp__add absent (${toolNamesBefore.length} tools)`);

  const enableProxy = await (
    await fetch(`http://127.0.0.1:${adminPort}/api/upstream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({
        server: {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          allow_private_network:true,
          url: `http://127.0.0.1:${mockPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      }),
    })
  ).json();
  if (!enableProxy.ok) throw new Error(JSON.stringify(enableProxy));
  log("admin API enabled allowlist proxy for mockhttp__add");

  const listAfter = await mcpPost(
    `http://127.0.0.1:${mcpPort}`,
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  const toolNamesAfter = listAfter.json.result.tools.map((t) => t.name);
  if (!toolNamesAfter.includes("mockhttp__add")) {
    throw new Error(`proxy missing after allowlist: ${toolNamesAfter.join(",")}`);
  }
  log(`tools/list after allowlist: mockhttp__add present`);

  const proxied = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mockhttp__add", { a: 1, b: 2 });
  if (!JSON.stringify(proxied).includes("POLICYGATE_APPROVAL_REQUIRED")) {
    throw new Error("dynamic upstream proxy ran without root-signed approval");
  }
  const proxiedPayload = { registered:true, unsigned_call_refused:true };

  const adminHtml = await (await fetch(`http://127.0.0.1:${adminPort}/ui/`,{headers:adminHeaders})).text();
  if (!adminHtml.includes("Import") || !adminHtml.includes("Claude Code") || !adminHtml.includes("OpenCode")) {
    throw new Error("admin ui missing expected import controls");
  }

  const fixture = path.join(tmpDir, "cursor-mcp-fixture.json");
  await fs.writeFile(
    fixture,
    JSON.stringify({ mcpServers: { imported: { command: "node", args: ["x.js"] } } }),
    "utf-8"
  );
  const imported = await (
    await fetch(`http://127.0.0.1:${adminPort}/api/import/cursor`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ path: fixture, merge: true }),
    })
  ).json();
  if (!imported.ok || !imported.imported.includes("imported")) throw new Error(JSON.stringify(imported));

  log("OK  bridge integration complete");
  await fs.writeFile(
    path.join(scratch, "mcp-bridge.log"),
    logLines.join("\n") +
      "\n" +
      JSON.stringify({ serversPayload, callPayload, toolNamesBefore, toolNamesAfter, proxiedPayload }, null, 2)
  );
  await fs.writeFile(
    path.join(scratch, "proxy-tool.log"),
    JSON.stringify({ before: toolNamesBefore, after: toolNamesAfter, result: proxiedPayload }, null, 2)
  );
  await fs.writeFile(path.join(scratch, "admin-ui.html"), adminHtml);
  await fs.writeFile(path.join(scratch, "import.log"), JSON.stringify(imported, null, 2));
  await fs.writeFile(path.join(scratch, "hub-boot.log"), hubLog);
} catch (err) {
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(path.join(scratch, "hub-boot.log"), hubLog + "\n--- mock ---\n" + mockLog);
  await fs.writeFile(path.join(scratch, "integration-error.log"), String(err?.stack || err));
  console.error("FAIL bridge integration:", err.message || err);
  console.error(hubLog.slice(-2000));
  process.exitCode=1;
} finally {
  hub.kill("SIGTERM");
  mockHttp.kill("SIGTERM");
  await Promise.all([hub,mockHttp].map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once("exit",resolve))));
  await fs.rm(scratch,{recursive:true,force:true});
}
