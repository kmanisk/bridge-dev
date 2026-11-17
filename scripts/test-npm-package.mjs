#!/usr/bin/env node
// Verify the publishable npm tarball in an isolated, disposable prefix.
// No global installation, service manipulation, root access, or npm publish.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { randomBytes } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dev-npm-pack-"));
const prefix = path.join(scratch, "install");
const home = path.join(scratch, "home");
const cache = path.join(scratch, "npm-cache");
const config = path.join(scratch, "config");
const workspace = path.join(scratch, "workspace");
for (const dir of [prefix, home, cache, config, workspace]) fs.mkdirSync(dir, { recursive: true });

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(MCP_TOKEN|ADMIN_TOKEN|POLICYGATE_|BRIDGEDEV_|LOCAL_CODER_|NODE_OPTIONS|NODE_PATH|MCP_UPSTREAM_CONFIG|PORT$|ADMIN_PORT$|HOST$|DOTENV_CONFIG_PATH$)/.test(key)) delete env[key];
}
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  XDG_DATA_HOME: path.join(scratch, "data"),
  XDG_CONFIG_HOME: config,
  XDG_CACHE_HOME: path.join(scratch, "cache"),
  WORKSPACE_PATH: workspace,
  BRIDGEDEV_SERVICE_ROOT: path.join(scratch, "service"),
  BRIDGEDEV_STATE_DIR: path.join(scratch, "state"),
  BRIDGEDEV_RUNTIME_MODE: "portable",
  DOTENV_CONFIG_PATH: path.join(config, "bridge-dev", ".env"),
  npm_config_cache: cache,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
});

function run(command, args, cwd, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: "utf8",
    shell: process.platform === "win32",
    timeout, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Do not dump CLI output: it can contain sensitive data on unexpected failures.
    throw new Error(`${path.basename(command)} ${args[0]} failed: ${result.error?.message || `exit ${result.status}`}`);
  }
  return result.stdout;
}

try {
  assert.equal(pkg.name, "bridge-dev");
  assert.equal(pkg.bin?.["bridge-dev"], "dist/cli.js");
  assert.equal(pkg.scripts?.prepack, "npm run build");

  const raw = run(npm, [
    "pack", "--json", "--pack-destination", scratch,
  ], root);
  const packed = JSON.parse(raw);
  // npm versions emit either an array or a package-name-keyed record.
  const info = Array.isArray(packed) ? packed[0] : packed?.[pkg.name];
  assert.ok(info && typeof info === "object", "Invalid npm pack metadata");
  assert.equal(info.name, "bridge-dev");
  assert.equal(info.version, pkg.version);
  const names = info.files.map(file => file.path);
  const required = [
    "dist/cli.js",
    "dist/index.js",
    "dist/admin/server.js",
    "public/ui/index.html",
    "public/ui/app.js",
    "profiles/marketplace.v1.json",
    "profiles/policy.example.json",
    "scripts/lease-activation.mjs",
    "scripts/deploy-acceptance/portable-client.mjs",
    "scripts/shadow-release-acceptance.mjs",
    "platform/windows-provider-cleanup.ps1",
    "docs/INSTALL.md",
    "README.md",
    "LICENSE",
    "package.json",
  ];
  for (const filename of required) {
    assert.ok(names.includes(filename), `Missing published file: ${filename}`);
  }
  for (const filename of names) {
    assert.doesNotMatch(filename, /(^|\/)(src|node_modules|\.git|\.env|\.npmrc|\.research|\.tools|coverage|test-output|\.policygate-dev\.audit\.jsonl)(\/|$)/);
    assert.doesNotMatch(filename, /^scripts\/test-/);
    assert.doesNotMatch(filename, /(^|\/)(?:id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx)|private-credentials\.json)(?:$|\/)/i);
  }
  assert.ok(info.size < 8 * 1024 * 1024, "Tarball unexpectedly large");

  const tarball = path.join(scratch, info.filename);
  assert.ok(fs.statSync(tarball).size > 0);
  run(npm, [
    "install", "--prefix", prefix, "--ignore-scripts",
    "--no-audit", "--no-fund", "--prefer-offline", tarball,
  ], scratch);
  const installed = path.join(prefix, "node_modules", pkg.name);
  const cli = path.join(installed, "dist", "cli.js");
  assert.ok(fs.existsSync(cli));
  assert.ok(fs.existsSync(path.join(installed, "public", "ui", "index.html")));
  assert.ok(fs.existsSync(path.join(installed, "scripts", "lease-activation.mjs")));
  // Scan the exact npm package content, not production state or dependencies.
  for (const filename of names) {
    if (!/\.(?:js|mjs|json|md|txt|css|html|ts)$/i.test(filename)) continue;
    const file = path.join(installed, ...filename.split("/"));
    const stat = fs.statSync(file);
    if (stat.size > 3 * 1024 * 1024) throw Error("Oversized text file in package");
    const body = fs.readFileSync(file,"utf8");
    assert.doesNotMatch(body, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
    assert.doesNotMatch(body, /(?:^|\n)\s*(?:MCP_TOKEN|ADMIN_TOKEN)\s*=\s*["\u0027]?[A-Za-z0-9._-]{32,}/);
  }
  const bin = path.join(prefix, "node_modules", ".bin",
    process.platform === "win32" ? "bridge-dev.cmd" : "bridge-dev");
  assert.ok(fs.existsSync(bin), "npm did not install the bridge-dev command");
  if (process.platform !== "win32") assert.ok(fs.statSync(bin).mode & 0o111, "Installed command is not executable");
  assert.match(run(bin, ["help"], scratch), /BridgeDev/i);
  assert.equal(run(bin, ["--version"], scratch).trim(), pkg.version);
  const outer = JSON.parse(run(process.execPath, [cli, "setup", "--json"], scratch));
  assert.equal(outer.ok, true);
  const setup = Array.isArray(outer.output) && typeof outer.output[0] === "string"
    ? JSON.parse(outer.output[0]) : outer;
  assert.equal(setup.ok, true);
  assert.equal(setup.runtime, "portable");
  assert.equal(setup.mode, "portable");
  assert.ok(setup.config.tokens_configured);

  function readCommandJson(args, allowWarning = false) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: scratch, env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.ok([0, ...(allowWarning ? [1] : [])].includes(result.status),
      `CLI ${args[0]} exit ${result.status}`);
    const outer = JSON.parse(result.stdout);
    return Array.isArray(outer.output) && typeof outer.output[0] === "string"
      ? JSON.parse(outer.output[0]) : outer;
  }
  const update = readCommandJson(["update", "--check", "--json"]);
  assert.equal(update.update_method, "npm");
  assert.match(update.command, /npm install -g bridge-dev@latest/);
  const diagnostics = readCommandJson(["doctor", "--json"], true);
  const installCheck = diagnostics.checks?.find(row => row.label === "Installation");
  assert.ok(installCheck?.detail?.startsWith("npm;"), "Doctor must identify npm install");
  const modeCheck = diagnostics.checks?.find(row => row.label === "Security mode");
  assert.match(modeCheck?.detail || "", /^STANDARD/, "npm CLI must not inherit managed YOLO");

  async function freePort() {
    const server = net.createServer();
    await new Promise((resolve,reject) => {
      server.once("error", reject);
      server.listen(0,"127.0.0.1",resolve);
    });
    const addr = server.address();
    await new Promise(resolve => server.close(resolve));
    assert.ok(addr && typeof addr === "object");
    return addr.port;
  }
  const [port, adminPort] = [await freePort(), await freePort()];
  assert.notEqual(port, adminPort);
  const mcpToken = randomBytes(32).toString("hex");
  const adminToken = randomBytes(32).toString("hex");
  const serverEnv = {
    ...env, PORT:String(port), ADMIN_PORT:String(adminPort), HOST:"127.0.0.1",
    MCP_TOKEN:mcpToken, ADMIN_TOKEN:adminToken, CHATGPT_TOOL_PROFILE:"slim",
  };
  const child = spawn(process.execPath,[cli,"start"],{
    cwd:scratch,env:serverEnv,stdio:["ignore","pipe","pipe"],
  });
  let outputBytes = 0;
  child.stdout.on("data",chunk => { outputBytes += chunk.length; });
  child.stderr.on("data",chunk => { outputBytes += chunk.length; });
  try {
    let health;
    for (let attempt=0; attempt<75 && !health; attempt++) {
      if (child.exitCode !== null) throw Error("Installed CLI gateway exited prematurely");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          headers:{Authorization:`Bearer ${mcpToken}`},
          signal:AbortSignal.timeout(650),
        });
        if (res.ok) health = await res.json();
      } catch {}
      if (!health) await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.equal(health?.status,"ok","Installed CLI gateway did not become ready");
    assert.equal(health?.runtimeMode,"portable");
    assert.equal(health?.fullMachineAccess,false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,401);
    const admin = await fetch(`http://127.0.0.1:${adminPort}/ui/`);
    assert.equal(admin.status,200,"Admin UI must load from npm tarball");
    assert.match(await admin.text(),/BridgeDev/i);
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method:"POST",
      headers:{Authorization:`Bearer ${mcpToken}`,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{
        protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"npm-smoke",version:"1"},
      }}),
      signal:AbortSignal.timeout(7000),
    });
    assert.equal(response.status,200,"Installed npm package MCP initialization");
    assert.match(await response.text(),/serverInfo|bridge-dev/i);
    assert.ok(outputBytes < 200_000,"Gateway produced excessive startup output");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve=>child.once("exit",resolve)),
        new Promise(resolve=>setTimeout(resolve,2500)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }

  console.log(JSON.stringify({
    result: "PASS", name: info.name, version: info.version,
    tarball_bytes: info.size, unpacked_bytes: info.unpackedSize,
    file_count: names.length, installed_cli: "PASS", isolated_setup: "PASS",
    install_type: "npm", doctor:"PASS", update_check:"PASS",
    gateway_start:"PASS", mcp_initialization:"PASS", admin_ui:"PASS",
  }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
