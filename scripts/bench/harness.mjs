#!/usr/bin/env node
/**
 * Isolated Benchmark Harness for BridgeDev
 * Measures:
 * - Startup time to first healthy response
 * - Idle RSS
 * - Session scaling (10, 50, 200 sessions) and per-session RSS
 * - Sustained tool-call throughput and latency (p50, p95, p99)
 * - Soak stability (configurable duration)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function getProcessMemory(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const vmrssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
    if (vmrssMatch) {
      return parseInt(vmrssMatch[1], 10) * 1024; // in bytes
    }
  } catch {}
  return 0;
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
}

function computePercentile(numbers, p) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function waitForHealth(port, token, maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(500),
      });
      if (res.status === 200 || res.status === 401) {
        return Date.now() - start;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Gateway failed to become healthy on port ${port} within ${maxWaitMs}ms`);
}

async function createMcpSession(port, token) {
  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "bench-client", version: "1.0.0" },
    },
  };

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(initBody),
  });

  if (!res.ok) {
    throw new Error(`Initialize failed: ${res.status} ${await res.text()}`);
  }

  const sessionId = res.headers.get("mcp-session-id");
  const data = await res.json();

  // Send initialized notification
  await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "mcp-session-id": sessionId || "",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  return { sessionId, serverInfo: data.result?.serverInfo };
}

async function callTool(port, token, sessionId, toolName, args = {}) {
  const start = performance.now();
  const reqBody = {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1000000),
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify(reqBody),
  });

  const duration = performance.now() - start;
  const ok = res.status === 200;
  return { ok, duration, status: res.status };
}

async function runBenchmark(options = {}) {
  const soakDurationSec = options.soakDuration || 30;
  const targetSessions = options.targetSessions || [10, 50, 200];
  const toolCallCount = options.toolCallCount || 300;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-bridge-dev-"));
  const workspaceDir = path.join(tempDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });

  const port = await getFreePort();
  const adminPort = await getFreePort();
  const token = randomBytes(24).toString("hex");

  const upstreamConfig = {
    version: 1,
    servers: [
      {
        id: "mock",
        name: "Mock Provider",
        enabled: true,
        transport: "stdio",
        command: "node",
        args: [path.join(__dirname, "mock-provider.mjs")],
        expose: "all",
      },
    ],
  };

  const etcDir = path.join(tempDir, "etc");
  fs.mkdirSync(etcDir, { recursive: true });
  fs.writeFileSync(path.join(etcDir, "upstream.json"), JSON.stringify(upstreamConfig, null, 2));

  console.log(`[BENCH] Starting isolated gateway on port ${port} (temp dir: ${tempDir})...`);
  const t0 = performance.now();

  const gw = spawn(
    process.execPath,
    [path.join(ROOT, "dist/index.js"), "serve"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_PORT: String(adminPort),
        MCP_TOKEN: token,
        WORKSPACE_PATH: workspaceDir,
        BRIDGEDEV_RUNTIME_MODE: "portable",
        BRIDGEDEV_STATE_DIR: path.join(tempDir, "state"),
        XDG_DATA_HOME: path.join(tempDir, "share"),
        XDG_CONFIG_HOME: path.join(tempDir, "config"),
        POLICYGATE_DATA_DIR: tempDir,
        POLICYGATE_ENV_FILE: path.join(etcDir, "service.env"),
        MCP_UPSTREAM_CONFIG: path.join(etcDir, "upstream.json"),
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let gwStderr = "";
  let gwStdout = "";
  gw.stdout.on("data", (d) => (gwStdout += d.toString()));
  gw.stderr.on("data", (d) => (gwStderr += d.toString()));

  const cleanup = async () => {
    try {
      gw.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      gw.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    let startupTimeMs;
    try {
      startupTimeMs = await waitForHealth(port, token);
    } catch (err) {
      console.error("[BENCH] Gateway stdout:\n", gwStdout);
      console.error("[BENCH] Gateway stderr:\n", gwStderr);
      throw err;
    }
    gw.on("error", (e) => console.error("[BENCH] Gateway proc error:", e));
    console.log(`[BENCH] Gateway healthy in ${startupTimeMs} ms.`);

    // Give V8 2 seconds to settle initial baseline
    await new Promise((r) => setTimeout(r, 2000));
    const idleRss = getProcessMemory(gw.pid);
    console.log(`[BENCH] Idle Gateway RSS: ${formatMb(idleRss)}`);

    // 1. Session Scaling Test
    console.log(`[BENCH] Running Session Scaling Suite (${targetSessions.join(", ")})...`);
    const sessionScalingResults = [];
    const activeSessions = [];

    let currentSessionCount = 0;
    for (const target of targetSessions) {
      const needed = target - currentSessionCount;
      const tStart = performance.now();
      for (let i = 0; i < needed; i++) {
        const sess = await createMcpSession(port, token);
        activeSessions.push(sess.sessionId);
      }
      currentSessionCount = target;
      await new Promise((r) => setTimeout(r, 500)); // allow settling
      const rss = getProcessMemory(gw.pid);
      const delta = rss - idleRss;
      const perSession = delta / target;
      sessionScalingResults.push({
        sessions: target,
        rssBytes: rss,
        rssFormatted: formatMb(rss),
        deltaFromIdle: formatMb(delta),
        perSessionBytes: Math.round(perSession),
        perSessionFormatted: formatMb(perSession),
      });
      console.log(`  - ${target} sessions: RSS = ${formatMb(rss)} (per session: ${formatMb(perSession)})`);
    }

    // 2. Sustained Tool-Call Throughput & Latency Test
    console.log(`[BENCH] Running Sustained Tool Calls (${toolCallCount} calls across active sessions)...`);
    const latencies = [];
    let successCount = 0;
    const benchStart = performance.now();

    const concurrency = 10;
    let callIndex = 0;

    async function worker() {
      while (callIndex < toolCallCount) {
        const idx = callIndex++;
        const sid = activeSessions[idx % activeSessions.length];
        const res = await callTool(port, token, sid, "mock_mock_echo", { message: `payload-${idx}` });
        if (res.ok) successCount++;
        latencies.push(res.duration);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const benchDurationSec = (performance.now() - benchStart) / 1000;
    const throughput = successCount / benchDurationSec;
    const postLoadRss = getProcessMemory(gw.pid);

    const p50 = computePercentile(latencies, 50);
    const p95 = computePercentile(latencies, 95);
    const p99 = computePercentile(latencies, 99);

    console.log(`[BENCH] Sustained Load Results:`);
    console.log(`  - Throughput: ${throughput.toFixed(2)} calls/sec`);
    console.log(`  - Latency: p50 = ${p50.toFixed(2)}ms, p95 = ${p95.toFixed(2)}ms, p99 = ${p99.toFixed(2)}ms`);
    console.log(`  - Post-load RSS: ${formatMb(postLoadRss)}`);

    // 3. Soak Test
    console.log(`[BENCH] Running Soak Stability Run (${soakDurationSec}s)...`);
    const soakStart = performance.now();
    const soakRssPoints = [];
    const intervalSec = Math.max(1, Math.floor(soakDurationSec / 10));

    while ((performance.now() - soakStart) / 1000 < soakDurationSec) {
      const sid = activeSessions[Math.floor(Math.random() * activeSessions.length)];
      await callTool(port, token, sid, "mock_mock_echo", { message: "soak-ping" });
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
      const curRss = getProcessMemory(gw.pid);
      soakRssPoints.push({
        elapsedSec: Math.round((performance.now() - soakStart) / 1000),
        rssBytes: curRss,
        rssFormatted: formatMb(curRss),
      });
    }

    const finalRss = getProcessMemory(gw.pid);
    const soakDriftBytes = finalRss - postLoadRss;
    console.log(`[BENCH] Soak Complete. Final RSS: ${formatMb(finalRss)} (Drift: ${formatMb(soakDriftBytes)})`);

    const report = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      startupTimeMs,
      idleRss: {
        bytes: idleRss,
        formatted: formatMb(idleRss),
      },
      sessionScaling: sessionScalingResults,
      sustainedLoad: {
        totalCalls: toolCallCount,
        successCalls: successCount,
        throughputRps: Math.round(throughput * 100) / 100,
        latencyMs: {
          p50: Math.round(p50 * 100) / 100,
          p95: Math.round(p95 * 100) / 100,
          p99: Math.round(p99 * 100) / 100,
        },
        postLoadRss: {
          bytes: postLoadRss,
          formatted: formatMb(postLoadRss),
        },
      },
      soak: {
        durationSec: soakDurationSec,
        finalRss: {
          bytes: finalRss,
          formatted: formatMb(finalRss),
        },
        driftBytes: soakDriftBytes,
        driftFormatted: formatMb(soakDriftBytes),
        points: soakRssPoints,
      },
    };

    const outDir = path.join(ROOT, "benchmarks");
    fs.mkdirSync(outDir, { recursive: true });
    const outName = options.outFile || "baseline-results.json";
    const outFile = path.join(outDir, outName);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`[BENCH] Results written to ${outFile}`);

    // Output Markdown Table
    console.log("\n=== BENCHMARK SUMMARY TABLE ===");
    console.log(`| Metric | Value |`);
    console.log(`| :--- | :--- |`);
    console.log(`| Node Version | \`${process.version}\` |`);
    console.log(`| Startup Time | ${startupTimeMs} ms |`);
    console.log(`| Idle RSS | ${formatMb(idleRss)} |`);
    for (const s of sessionScalingResults) {
      console.log(`| RSS @ ${s.sessions} Sessions | ${s.rssFormatted} (per session: ${s.perSessionFormatted}) |`);
    }
    console.log(`| Throughput | ${throughput.toFixed(2)} req/sec |`);
    console.log(`| Latency p50 / p95 / p99 | ${p50.toFixed(2)}ms / ${p95.toFixed(2)}ms / ${p99.toFixed(2)}ms |`);
    console.log(`| Soak (${soakDurationSec}s) Final RSS | ${formatMb(finalRss)} (drift: ${formatMb(soakDriftBytes)}) |`);
    console.log("================================\n");

    return report;
  } catch (err) {
    console.error("[BENCH] Gateway stdout on failure:\n", gwStdout);
    console.error("[BENCH] Gateway stderr on failure:\n", gwStderr);
    throw err;
  } finally {
    await cleanup();
  }
}

const args = process.argv.slice(2);
let soakSec = 30;
const soakIdx = args.indexOf("--soak");
if (soakIdx !== -1 && args[soakIdx + 1]) {
  soakSec = parseInt(args[soakIdx + 1], 10);
}
let outFile = "baseline-results.json";
const outIdx = args.indexOf("--out");
if (outIdx !== -1 && args[outIdx + 1]) {
  outFile = args[outIdx + 1];
}

runBenchmark({ soakDuration: soakSec, outFile }).catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
