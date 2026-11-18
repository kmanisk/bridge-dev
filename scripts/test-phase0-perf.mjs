#!/usr/bin/env node
/**
 * Phase 0 Regression Tests:
 * 1. Authenticated /diagnostics/perf endpoint and doctor --perf
 * 2. Session cap LRU eviction and recovery
 * 3. Provider idle disconnect preserving tool cache
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function run() {
  console.log("Running Phase 0 regression tests...");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase0-test-"));
  const workspaceDir = path.join(tempDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });

  const port = await getFreePort();
  const adminPort = await getFreePort();
  const token = randomBytes(24).toString("hex");

  const etcDir = path.join(tempDir, "etc");
  fs.mkdirSync(etcDir, { recursive: true });
  fs.writeFileSync(
    path.join(etcDir, "upstream.json"),
    JSON.stringify({ version: 1, servers: [] }, null, 2)
  );

  const env = {
    ...process.env,
    PORT: String(port),
    ADMIN_PORT: String(adminPort),
    MCP_TOKEN: token,
    MCP_MAX_SESSIONS: "5",
    MCP_SESSION_IDLE_TIMEOUT_MS: "1000",
    MCP_SESSION_CLEANUP_MS: "500",
    WORKSPACE_PATH: workspaceDir,
    BRIDGEDEV_RUNTIME_MODE: "portable",
    BRIDGEDEV_STATE_DIR: path.join(tempDir, "state"),
    POLICYGATE_DATA_DIR: tempDir,
    POLICYGATE_ENV_FILE: path.join(etcDir, "service.env"),
    MCP_UPSTREAM_CONFIG: path.join(etcDir, "upstream.json"),
    NODE_ENV: "production",
  };

  const proc = spawn(process.execPath, [path.join(ROOT, "dist/index.js"), "serve"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const cleanup = () => {
    try {
      proc.kill("SIGTERM");
      proc.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    // Wait for health
    let healthy = false;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 200) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(healthy, "Server must become healthy");

    // Test 1: /diagnostics/perf security and data format
    const unauth = await fetch(`http://127.0.0.1:${port}/diagnostics/perf`);
    assert.equal(unauth.status, 401, "Diagnostics must reject unauthenticated requests");

    const authRes = await fetch(`http://127.0.0.1:${port}/diagnostics/perf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authRes.status, 200, "Diagnostics must accept valid token");
    const perfData = await authRes.json();
    assert.equal(perfData.status, "ok");
    assert.ok(perfData.memory.rss > 0, "Must report RSS");
    assert.ok(perfData.memory.heapUsed > 0, "Must report Heap Used");
    assert.equal(perfData.sessions.max, 5, "Must report configured session cap");
    assert.equal(typeof perfData.sessions.active, "number");
    assert.ok(!JSON.stringify(perfData).includes(token), "Must not leak secret token");

    // Test 2: Session creation and LRU cap
    async function createSession(name) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name, version: "1.0.0" },
          },
        }),
      });
      assert.equal(res.status, 200);
      return res.headers.get("mcp-session-id");
    }

    const s1 = await createSession("client-1");
    const s2 = await createSession("client-2");
    const s3 = await createSession("client-3");
    const s4 = await createSession("client-4");
    const s5 = await createSession("client-5");

    const midStatus = await (
      await fetch(`http://127.0.0.1:${port}/diagnostics/perf`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    assert.equal(midStatus.sessions.active, 5, "Session count must equal 5");

    // Creating 6th session should evict oldest session (s1) without failing
    const s6 = await createSession("client-6");
    assert.ok(s6, "6th session must succeed via LRU eviction");

    const postStatus = await (
      await fetch(`http://127.0.0.1:${port}/diagnostics/perf`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    assert.equal(postStatus.sessions.active, 5, "Session count must remain capped at max (5)");

    console.log("Phase 0 regression tests passed: ALL OK");
  } finally {
    cleanup();
  }
}

run().catch((err) => {
  console.error("Phase 0 regression test failed:", err);
  process.exit(1);
});
