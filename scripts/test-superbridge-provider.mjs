// Optional interoperability smoke test. It never installs or modifies Super Bridge.
// With no env vars it only checks that public examples import disabled by default.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseMcpServersFile } from "../dist/lib/mcp-upstream-config.js";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const filename of ["superbridge-local.mcp.example.json", "superbridge-wsl.mcp.example.json"]) {
  const contents = JSON.parse(await fs.readFile(path.join(base, "examples", filename), "utf8"));
  const entries = parseMcpServersFile(contents);
  assert.equal(entries.length, 1, filename);
  const config = entries[0];
  assert.equal(config.id, "superbridge", filename);
  assert.equal(config.enabled, false, "A public example must never auto-enable a provider");
  assert.equal(config.expose, "none", "An imported provider must expose zero tools");
  assert.deepEqual(config.tools, []);
  assert.equal(config.transport, "stdio");
  assert.ok(config.command);
  assert.deepEqual(config.args.slice(-3, -2), ["stdio"]);
  assert.ok(config.args.at(-1).endsWith("/router/bridge.sock"));
}
console.log("Super Bridge examples: valid imports, disabled by default, zero tool exposure");

const binary = process.env.SUPERBRIDGE_BIN?.trim();
const socket = process.env.SUPERBRIDGE_RELAY_SOCKET?.trim();
const requireDevice = process.env.SUPERBRIDGE_REQUIRE_DEVICE === "1";
if (!binary && !socket) {
  if (requireDevice) throw new Error("SUPERBRIDGE_REQUIRE_DEVICE needs SUPERBRIDGE_BIN and SUPERBRIDGE_RELAY_SOCKET");
  console.log("Optional live test skipped: supply SUPERBRIDGE_BIN and SUPERBRIDGE_RELAY_SOCKET");
  process.exit(0);
}
if (!binary || !socket || !path.isAbsolute(binary) || !path.isAbsolute(socket)) {
  throw new Error("Both SUPERBRIDGE_BIN and SUPERBRIDGE_RELAY_SOCKET must be absolute paths");
}
if (process.platform !== "linux") {
  throw new Error("Live stdio+Unix-socket test requires Linux (native or WSL2)");
}
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-dev-superbridge-"));
const previous = Object.fromEntries(["HOME", "WORKSPACE_PATH", "BRIDGEDEV_STATE_DIR", "BRIDGEDEV_RUNTIME_MODE"].map(k => [k, process.env[k]]));
let manager;
try {
  const home = path.join(testRoot, "home");
  const workspace = path.join(testRoot, "workspace");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  process.env.HOME = home;
  process.env.WORKSPACE_PATH = workspace;
  process.env.BRIDGEDEV_STATE_DIR = path.join(testRoot, "state");
  process.env.BRIDGEDEV_RUNTIME_MODE = "portable";
  const { McpUpstreamManager } = await import("../dist/lib/mcp-upstream-manager.js");
  manager = new McpUpstreamManager(path.join(testRoot, "providers.json"));
  await manager.init();
  assert.equal(manager.initializationError, undefined);
  const config = {
    id: "superbridge",
    name: "Super Bridge read-only interoperability smoke test",
    enabled: true,
    transport: "stdio",
    command: binary,
    args: ["stdio", "--device-relay", socket],
    expose: "allowlist",
    tools: ["bridge_status", "devices_list", ...(requireDevice ? ["device_fs_list", "device_operation_status"] : [])],
    tool_permissions: { bridge_status: "R", devices_list: "R", ...(requireDevice ? {device_fs_list:"R", device_operation_status:"R"} : {}) }
  };
  // Disposable, trusted test registry only; production review is never bypassed.
  await manager.updateConfig({version: 1, servers: [config]});
  const tested = await manager.testProvider("superbridge");
  assert.equal(tested.status.health, "reachable");
  const tools = tested.tools.map(tool => tool.name);
  for (const name of ["bridge_status", "devices_list"]) assert.ok(tools.includes(name), "Missing "+name);
  const proxied = manager.getProxiedToolNames(config, tested.tools);
  assert.deepEqual(proxied.sort(), ["superbridge__bridge_status", "superbridge__devices_list", ...(requireDevice ? ["superbridge__device_fs_list", "superbridge__device_operation_status"] : [])].sort());
  await assert.rejects(
    manager.callTool("superbridge", "device_exec", {}),
    /PROVIDER_TOOL_DENIED/,
    "Execution must fail before touching Super Bridge"
  );
  const result = await manager.callTool("superbridge", "bridge_status", {});
  if (result.isError) {
    const detail = (result.content ?? []).filter(item => item.type === "text")
      .map(item => String(item.text).replace(/[a-f0-9]{32,}/gi, "[HASH]").slice(0, 350)).join("; ");
    throw new Error("Read-only status call failed: " + detail);
  }
  console.log("Live BridgeDev -> Super Bridge: stdio, tools/list, reviewed read-only call PASS");
  if (requireDevice) {
    // Opt-in physical device test: no root, writes, commands, or private output.
    function decode(result) {
      if (result.isError) throw new Error("MCP tool returned an error");
      const entry = (result.content ?? []).find(item => item.type === "text" && item.text.startsWith("{"));
      if (!entry) throw new Error("MCP result missing JSON content");
      return JSON.parse(entry.text);
    }
    const deviceResponse = decode(await manager.callTool("superbridge", "devices_list", {}));
    const devices = deviceResponse.devices ?? [];
    const requestedName = process.env.SUPERBRIDGE_DEVICE_NAME?.trim();
    const device = requestedName
      ? devices.find(entry => entry.name === requestedName)
      : devices.length === 1 ? devices[0] : undefined;
    if (!device) throw new Error("Select one connected device with SUPERBRIDGE_DEVICE_NAME (or connect exactly one)");
    const request_key = "bridge-dev-device-smoke-" + randomUUID().replaceAll("-", "");
    const listed = await manager.callTool("superbridge", "device_fs_list", {
      device_id: device.id, request_key, path: ".", root: false
    });
    let receipt = decode(listed);
    for (let i = 0; i < 55 && !["completed", "failed", "denied", "unknown"].includes(receipt.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      receipt = decode(await manager.callTool("superbridge", "device_operation_status", {request_key}));
    }
    assert.equal(receipt.status, "completed", "Read-only device fs_list did not complete");
    assert.ok(Array.isArray(receipt.result?.entries), "Device list result malformed");
    console.log("Physical device: reviewed read-only fs_list and receipt polling PASS");
  }
} finally {
  await manager?.shutdown();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(testRoot, {recursive: true, force: true});
}
