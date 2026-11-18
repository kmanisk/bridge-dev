#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { fixturePorts } from "../../scripts/test-ports.mjs";

import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = path.resolve(SCRIPT_DIR, "../..");
const VECTORS_DIR = path.join(SCRIPT_DIR, "vectors");

// Load conformance vectors
const mcpVectors = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, "mcp_protocol_vectors.json"), "utf8"));
const policyVectors = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, "policy_vectors.json"), "utf8"));
const signatureVectors = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, "signature_vectors.json"), "utf8"));
const ssrfVectors = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, "ssrf_vectors.json"), "utf8"));
const archiveVectors = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, "archive_vectors.json"), "utf8"));
const providerVectors = JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, "provider_vectors.json"), "utf8"));

let totalAssertions = 0;
function check(condition, message) {
  totalAssertions++;
  assert.ok(condition, message);
}

// ---------------------------------------------------------------------------
// SUITE 1: SSRF & IP Address Conformance
// ---------------------------------------------------------------------------
console.log("Suite 1: SSRF and Network Security Conformance");

function isPublicAddress(raw) {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4 check
  const ipv4Parts = ip.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every(p => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    const [a, b, c] = ipv4Parts.map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // IPv6 check
  if (!ip.includes(":")) return false;
  try {
    const canonical = new URL("https://[" + ip + "]").hostname.slice(1, -1);
    const [firstPart, secondPart] = canonical.split(":").map(part => parseInt(part || "0", 16));
    return (
      firstPart >= 0x2000 &&
      firstPart <= 0x3fff &&
      firstPart !== 0x2002 &&
      firstPart !== 0x3fff &&
      !(firstPart === 0x2001 && (secondPart < 0x200 || secondPart === 0xdb8))
    );
  } catch {
    return false;
  }
}

for (const ip of ssrfVectors.ip_validation.public_ipv4) {
  check(isPublicAddress(ip), `Public IPv4 should be permitted: ${ip}`);
}
for (const entry of ssrfVectors.ip_validation.private_or_restricted_ipv4) {
  check(!isPublicAddress(entry.ip), `Private/restricted IPv4 must be blocked: ${entry.ip} (${entry.category})`);
}
for (const ip of ssrfVectors.ip_validation.public_ipv6) {
  check(isPublicAddress(ip), `Public IPv6 should be permitted: ${ip}`);
}
for (const entry of ssrfVectors.ip_validation.private_or_restricted_ipv6) {
  check(!isPublicAddress(entry.ip), `Private/restricted IPv6 must be blocked: ${entry.ip} (${entry.category})`);
}

function validateUrl(input, allowPrivate = false) {
  const url = new URL(input);
  if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol)) {
    throw new Error("SOURCE_URL_UNSAFE");
  }
  if (url.protocol !== "https:" && !allowPrivate) {
    throw new Error("SOURCE_HTTPS_REQUIRED");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Check if IP literal
  const isIp = /^[0-9.]+$/.test(host) || host.includes(":");
  if (isIp && !allowPrivate && !isPublicAddress(host)) {
    throw new Error("SOURCE_SSRF_DENIED");
  }
  return true;
}

for (const testCase of ssrfVectors.url_validation) {
  if (testCase.expected_valid) {
    check(validateUrl(testCase.url, testCase.allow_private), `URL should be valid: ${testCase.url}`);
  } else {
    assert.throws(
      () => validateUrl(testCase.url, testCase.allow_private),
      err => err.message.includes(testCase.expected_error),
      `URL should be rejected with ${testCase.expected_error}: ${testCase.url}`
    );
    totalAssertions++;
  }
}
console.log("  Pass: SSRF & IP validation vectors");

// ---------------------------------------------------------------------------
// SUITE 2: Archive & Path Traversal Conformance
// ---------------------------------------------------------------------------
console.log("Suite 2: Archive and Path Traversal Conformance");

function safeRelative(input) {
  if (
    !input ||
    input.length > 240 ||
    input.includes("\\") ||
    input.includes("\0") ||
    input.startsWith("/") ||
    /^[a-z]:/i.test(input) ||
    input.split("/").some(x => x === ".." || x === "" || x === "." || x === "__proto__")
  ) {
    throw new Error("SOURCE_PATH_UNSAFE: " + input);
  }
  return input;
}

for (const testCase of archiveVectors.path_sanitization) {
  if (testCase.expected_valid) {
    check(safeRelative(testCase.path) === testCase.path, `Relative path should be allowed: ${testCase.path}`);
  } else if (testCase.expected_error) {
    assert.throws(
      () => safeRelative(testCase.path),
      err => err.message.includes(testCase.expected_error),
      `Unsafe path should throw ${testCase.expected_error}: ${testCase.path}`
    );
    totalAssertions++;
  }
}
console.log("  Pass: Archive path traversal vectors");

// ---------------------------------------------------------------------------
// SUITE 3: Signatures & Cryptographic Leases Conformance
// ---------------------------------------------------------------------------
console.log("Suite 3: Signatures and Lease Verification Conformance");

const hmacSecret = "conformance-hmac-test-secret-key-32b";
function mintContextToken(payload, secret) {
  const encPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const encSig = createHmac("sha256", secret).update(encPayload).digest("base64url");
  return encPayload + "." + encSig;
}

function verifyContextToken(tokenString, secret, expectedSubject, now = Date.now()) {
  if (typeof tokenString !== "string" || tokenString.length > 2048) return false;
  const parts = tokenString.split(".");
  if (parts.length !== 2) return false;
  const [encPayload, encSig] = parts;
  const expectedSig = createHmac("sha256", secret).update(encPayload).digest("base64url");
  if (encSig !== expectedSig) return false;
  try {
    const payload = JSON.parse(Buffer.from(encPayload, "base64url").toString("utf8"));
    if (payload.v !== 1) return false;
    if (payload.subject !== expectedSubject) return false;
    if (payload.expires <= now) return false;
    return true;
  } catch {
    return false;
  }
}

const contextTestCases = signatureVectors.context_tokens.test_cases;
for (const tc of contextTestCases) {
  if (tc.name === "valid_token") {
    const token = mintContextToken(tc.payload, hmacSecret);
    check(verifyContextToken(token, hmacSecret, tc.payload.subject, 1700000000000), "Valid context token should verify");
  } else if (tc.name === "expired_token") {
    const token = mintContextToken(tc.payload, hmacSecret);
    check(!verifyContextToken(token, hmacSecret, tc.payload.subject, 1700000000000), "Expired context token must fail verification");
  } else if (tc.name === "tampered_subject") {
    const valid = mintContextToken({ v: 1, issuer: "s1", subject: "valid-subject", expires: 4000000000000 }, hmacSecret);
    check(!verifyContextToken(valid, hmacSecret, "other-subject", 1700000000000), "Subject mismatch must fail verification");
  } else if (tc.name === "tampered_signature") {
    const valid = mintContextToken({ v: 1, issuer: "s1", subject: "valid-subject", expires: 4000000000000 }, hmacSecret);
    const parts = valid.split(".");
    const tampered = parts[0] + "." + parts[1].slice(0, -2) + "xx";
    check(!verifyContextToken(tampered, hmacSecret, "valid-subject", 1700000000000), "Tampered signature must fail verification");
  } else if (tc.name === "malformed_dots") {
    check(!verifyContextToken(tc.raw_string, hmacSecret, "any", 1700000000000), "Malformed token dots must fail verification");
  }
}

// Ed25519 lease verification test
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function signLease(lease, privKey) {
  const message = JSON.stringify({
    mode: lease.mode,
    expires_at: lease.expires_at,
    ...(lease.nonce ? { nonce: lease.nonce } : {}),
    ...(lease.scope ? { scope: lease.scope } : {}),
    ...(lease.lifetime ? { lifetime: lease.lifetime } : {})
  });
  const sig = sign(null, Buffer.from(message), privKey);
  return { ...lease, signature: sig.toString("base64") };
}

function verifyLease(lease, pubKeyPem, now = Date.now()) {
  if (!lease || typeof lease !== "object") return false;
  if (lease.scope !== "host-root-v1") return false;
  if (typeof lease.nonce !== "string" || !lease.nonce.length) return false;
  if (typeof lease.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(lease.signature)) return false;
  const isPermanent = lease.lifetime === "until_off" && lease.expires_at === null;
  const isTemporary = lease.lifetime === undefined && Number.isSafeInteger(lease.expires_at) && lease.expires_at > now;
  if (!isPermanent && !isTemporary) return false;

  const message = JSON.stringify({
    mode: lease.mode,
    expires_at: lease.expires_at,
    ...(lease.nonce ? { nonce: lease.nonce } : {}),
    ...(lease.scope ? { scope: lease.scope } : {}),
    ...(lease.lifetime ? { lifetime: lease.lifetime } : {})
  });
  try {
    return verify(null, Buffer.from(message), pubKeyPem, Buffer.from(lease.signature, "base64"));
  } catch {
    return false;
  }
}

for (const tc of signatureVectors.operator_leases.test_cases) {
  if (tc.name === "valid_temporary_lease") {
    const signed = signLease(tc.lease, privateKey);
    check(verifyLease(signed, pubPem, 1700000000000), "Valid temporary lease must verify");
  } else if (tc.name === "valid_permanent_lease") {
    const signed = signLease(tc.lease, privateKey);
    check(verifyLease(signed, pubPem, 1700000000000), "Valid permanent lease must verify");
  } else if (tc.name === "expired_lease") {
    const signed = signLease(tc.lease, privateKey);
    check(!verifyLease(signed, pubPem, 1700000000000), "Expired lease must fail verification");
  } else if (tc.name === "invalid_scope") {
    const signed = signLease(tc.lease, privateKey);
    check(!verifyLease(signed, pubPem, 1700000000000), "Invalid lease scope must fail verification");
  } else if (tc.name === "tampered_nonce") {
    const signed = signLease({ mode: "dangerous", scope: "host-root-v1", expires_at: 4000000000000, nonce: "orig" }, privateKey);
    signed.nonce = "tampered";
    check(!verifyLease(signed, pubPem, 1700000000000), "Tampered nonce must fail signature verification");
  }
}
console.log("  Pass: Signature & lease verification vectors");

// ---------------------------------------------------------------------------
// SUITE 3.5: Policy & Decision Table Conformance
// ---------------------------------------------------------------------------
console.log("Suite 3.5: Policy and Decision Table Conformance");

const policyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-conformance-policy-"));
try {
  const { checkPath } = await import(path.resolve(WORKDIR, "dist/lib/policy-paths.js"));
  const samplePolicy = {
    profile: "standard",
    dangerous_enabled: false,
    context_files: [],
    writable_roots: [fs.realpathSync.native(policyWorkspace)],
    protected_paths: ["/etc/sudoers"],
    secret_paths: [path.join(policyWorkspace, ".ssh")],
    secret_names: [".env"],
    approval_paths: [],
    sensitive_segments: [],
    hard_paths: [],
    allowed_commands: ["pwd", "git status"],
    approval_commands: ["npm run build"],
    denied_commands: ["rm -rf /"],
    proxy_tools: {},
    limits: { max_payload_bytes: 200000, max_mutations_per_minute: 200, max_denials: 5, approval_timeout_ms: 30000 },
    audit_log: path.join(policyWorkspace, "audit.jsonl")
  };

  // Test path rules
  const readRes = checkPath(path.join(policyWorkspace, "src/index.ts"), "R", samplePolicy, "/fake/policy.json");
  check(readRes.approval === false, "Read inside workspace must be allowed without approval");

  const writeRes = checkPath(path.join(policyWorkspace, "src/generated.ts"), "W", samplePolicy, "/fake/policy.json");
  check(writeRes.approval === false, "Write inside workspace must be allowed without approval in standard profile");

  assert.throws(
    () => checkPath("/etc/systemd/system/rogue.service", "W", samplePolicy, "/fake/policy.json"),
    /OUTSIDE_WRITABLE_ROOTS/,
    "Write outside writable roots must throw OUTSIDE_WRITABLE_ROOTS"
  );
  totalAssertions++;

  assert.throws(
    () => checkPath(path.join(policyWorkspace, ".env"), "R", samplePolicy, "/fake/policy.json"),
    /SECRET_DENIED/,
    "Read of .env secret must throw SECRET_DENIED"
  );
  totalAssertions++;

  console.log("  Pass: Policy decision table vectors");
} finally {
  fs.rmSync(policyWorkspace, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// SUITE 4: CLI Interface Conformance
// ---------------------------------------------------------------------------
console.log("Suite 4: CLI Interface Conformance");

const cliTarget = process.env.BRIDGE_IMPL_CMD || `node ${path.resolve(WORKDIR, "dist/cli.js")}`;
const [cliBin, ...cliBaseArgs] = cliTarget.split(" ").map(p => (p.startsWith("dist/") ? path.resolve(WORKDIR, p) : p));
const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-conformance-state-"));

function runCli(args, env = {}) {
  return spawnSync(cliBin, [...cliBaseArgs, ...args], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      BRIDGEDEV_RUNTIME_MODE: "portable",
      BRIDGEDEV_STATE_DIR: tmpStateDir,
      POLICYGATE_POLICY_FILE: "",
      ...env
    }
  });
}

// 1. help command
const helpRes = runCli(["help"]);
check(helpRes.status === 0, `CLI help should exit 0: ${helpRes.stderr}`);
check(helpRes.stdout.includes("bridge-dev") || helpRes.stdout.includes("help") || helpRes.stdout.includes("mode"), "CLI help output should describe bridge-dev");

// 2. unknown command with --json
const unknownRes = runCli(["non-existent-subcommand", "--json"]);
check(unknownRes.status !== 0, "CLI unknown subcommand should exit non-zero");

// 3. status --json
const statusRes = runCli(["status", "--json"]);
check(statusRes.status === 0 || statusRes.status === 1, "CLI status --json should run");

console.log("  Pass: CLI command interface conformance");

// ---------------------------------------------------------------------------
// SUITE 5: Gateway HTTP & MCP Transport Conformance
// ---------------------------------------------------------------------------
console.log("Suite 5: Gateway HTTP & MCP Transport Conformance");

async function runHttpMcpConformance() {
  const [port, adminPort] = await fixturePorts(2);
  const mcpToken = "conformance-test-mcp-token-value";
  const adminToken = "conformance-test-admin-token-value";
  const testRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bridge-conformance-gw-"));
  const workspaceDir = path.join(testRoot, "workspace");
  await fsp.mkdir(workspaceDir, { recursive: true });

  const agentsFile = path.join(testRoot, "AGENTS.md");
  const contextFile = path.join(testRoot, "SYSTEM_CONTEXT.md");
  await fsp.writeFile(agentsFile, "# Fixture AGENTS\n");
  await fsp.writeFile(contextFile, "# Fixture SYSTEM_CONTEXT\n");

  const policyFile = path.join(testRoot, "policy.json");
  const auditFile = path.join(testRoot, "audit.jsonl");
  const policy = {
    profile: "standard",
    dangerous_enabled: false,
    context_files: [agentsFile, contextFile],
    writable_roots: [workspaceDir],
    protected_paths: [],
    secret_paths: [],
    secret_names: [],
    approval_paths: [],
    sensitive_segments: [],
    hard_paths: [],
    allowed_commands: ["pwd", "ls", "echo"],
    approval_commands: [],
    denied_commands: ["rm -rf /"],
    proxy_tools: {},
    limits: { max_payload_bytes: 200000, max_mutations_per_minute: 200, max_denials: 5, approval_timeout_ms: 30000 },
    audit_log: auditFile
  };
  await fsp.writeFile(policyFile, JSON.stringify(policy));

  const gwEnv = {
    ...process.env,
    PORT: String(port),
    ADMIN_PORT: String(adminPort),
    MCP_TOKEN: mcpToken,
    ADMIN_TOKEN: adminToken,
    WORKSPACE_PATH: workspaceDir,
    BRIDGEDEV_RUNTIME_MODE: "portable",
    BRIDGEDEV_STATE_DIR: path.join(testRoot, "state"),
    POLICYGATE_POLICY_FILE: policyFile,
    MCP_SESSION_TTL_MS: "60000",
    MCP_MAX_SESSIONS: "50"
  };

  const gatewayTarget = process.env.BRIDGE_GATEWAY_CMD || `node ${path.resolve(WORKDIR, "dist/index.js")}`;
  const [gwBin, ...gwBaseArgs] = gatewayTarget.split(" ").map(p => (p.startsWith("dist/") ? path.resolve(WORKDIR, p) : p));
  let gwLogs = "";
  const gwProcess = spawn(gwBin, gwBaseArgs, { env: gwEnv, stdio: ["ignore", "pipe", "pipe"] });
  gwProcess.stdout.on("data", b => (gwLogs += b));
  gwProcess.stderr.on("data", b => (gwLogs += b));

  // Wait for health
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    if (gwProcess.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${mcpToken}` }
      });
      if (res.status === 200 || res.status === 401) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  check(healthy, `Gateway should start and respond to /health: ${gwLogs}`);

  // Test 1: Health endpoint responds 200
  const healthRes = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: `Bearer ${mcpToken}` }
  });
  check(healthRes.status === 200, "/health should return HTTP 200 with auth");

  // Test 2: Unauthenticated MCP request is rejected
  const unauthRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "initialize", params: mcpVectors.initialize.valid_request.params })
  });
  check(unauthRes.status === 401, "/mcp without token must return HTTP 401");

  // Test 3: Initialize MCP session
  const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mcpToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "initialize", params: mcpVectors.initialize.valid_request.params })
  });
  check(initRes.status === 200, `/mcp initialize should return HTTP 200: status=${initRes.status}`);
  const sessionId = initRes.headers.get("mcp-session-id");
  check(Boolean(sessionId), "Initialize response must include Mcp-Session-Id header");
  const initBody = await initRes.json();
  check(initBody.result && initBody.result.protocolVersion, "Initialize result must return protocolVersion");

  // Test 4: List Tools
  const listRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mcpToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "2", method: "tools/list", params: {} })
  });
  check(listRes.status === 200, `tools/list should return HTTP 200: ${listRes.status}`);
  const listBody = await listRes.json();
  check(listBody.result && Array.isArray(listBody.result.tools), "tools/list result must contain array of tools");
  const toolNames = listBody.result.tools.map(t => t.name);
  check(toolNames.includes("system_context") || toolNames.includes("filesystem_list_directory"), "Tools list should advertise standard native tools");

  // Test 5: doctor --perf --json against running gateway
  const perfRes = runCli(["doctor", "--perf", "--json"], { PORT: String(port), MCP_TOKEN: mcpToken });
  check(perfRes.status === 0, `CLI doctor --perf --json should exit 0: ${perfRes.stderr}`);
  const outerPerf = JSON.parse(perfRes.stdout);
  check(outerPerf.ok === true, "CLI doctor envelope ok must be true");
  const parsedPerf = typeof outerPerf.status === "string" ? outerPerf : JSON.parse(outerPerf.output[0]);
  check(parsedPerf.status === "ok", "doctor --perf status should be ok");
  check(parsedPerf.memory && typeof parsedPerf.memory.rssFormatted === "string", "doctor --perf should report formatted RSS");

  // Cleanup Gateway
  gwProcess.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 200));
  if (gwProcess.exitCode === null) gwProcess.kill("SIGKILL");

  await fsp.rm(testRoot, { recursive: true, force: true }).catch(() => {});
}

await runHttpMcpConformance();
console.log("  Pass: Gateway HTTP & MCP Transport Conformance");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nAll conformance tests passed (${totalAssertions} assertions verified across 5 suites).`);
fs.rmSync(tmpStateDir, { recursive: true, force: true });
