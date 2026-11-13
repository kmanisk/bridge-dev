#!/usr/bin/env node

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { randomUUID, timingSafeEqual } from "crypto";

import {
  setDefaultCwd,
  getDefaultCwd,
  getFullDiskAccess,
} from "./lib/path-security.js";
import {
  consumeSessionTransportError,
  createSessionManager,
  extractRequestId,
  isInitializeRequest,
} from "./lib/mcp-session-manager.js";
import { initUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { startAdminServer } from "./admin/server.js";
import { logMcpHttpEvent, logMcpRequest } from "./lib/activity-log.js";
import {
  buildInstructionContext,
  summarizeInstructionContext,
  type InstructionContext,
} from "./lib/instruction-context.js";
import { getChatGptToolProfile } from "./lib/tool-profile.js";
import { getPolicyGate } from "./lib/policy-gateway.js";
import { getRuntimeMode, platformCapabilities } from "./lib/runtime.js";

// Policy is loaded once before listening or registering handlers.
getPolicyGate();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const MCP_TOKEN = (process.env.MCP_TOKEN || "").trim();
if (getRuntimeMode() === "portable" && !["127.0.0.1","localhost","::1"].includes(HOST)) {
  throw new Error("Portable BridgeDev may listen only on loopback; install a managed gateway for public exposure.");
}
if (!MCP_TOKEN || /[\x00-\x20/\\?#]/.test(MCP_TOKEN)) throw new Error("Configure a nonempty MCP_TOKEN without whitespace or URL separators before serving");
if (process.env.ADMIN_TOKEN?.trim() === MCP_TOKEN) throw new Error("MCP_TOKEN and ADMIN_TOKEN must be independent");
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "3001", 10);
const SHELL_TIMEOUT = parseInt(process.env.SHELL_TIMEOUT || "120", 10);
const SESSION_RECOVERY =
  (process.env.MCP_SESSION_RECOVERY || "true").toLowerCase() !== "false";

function splitWorkspaceEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((p) => p.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

function resolveWorkspaceRoots(): string[] {
  const configuredRoots = [
    ...splitWorkspaceEnv(process.env.WORKSPACE_PATH || process.cwd()),
    ...splitWorkspaceEnv(process.env.EXTRA_WORKSPACE_PATHS),
    ...splitWorkspaceEnv(process.env.WORKSPACE_PATHS),
    ...splitWorkspaceEnv(process.env.ALLOWED_WORKSPACE_PATHS),
  ];

  const roots = configuredRoots.map((p) => path.resolve(p));
  return [...new Set(roots)];
}

const workspaceRoots = resolveWorkspaceRoots();
const workspaceRoot = workspaceRoots[0] || process.cwd();
setDefaultCwd(workspaceRoot);

const upstreamManager = await initUpstreamManager();

const instructionContext: InstructionContext = await buildInstructionContext({
  workspaceRoot,
  workspaceRoots,
  pid: process.pid,
  adminPort: ADMIN_PORT,
});

if (instructionContext.projectMemory.sections.length > 0) {
  console.log(
    `[MCP] Project memory: ${instructionContext.projectMemory.sections.length} file(s) from ${workspaceRoot} (${instructionContext.projectMemory.total_bytes} bytes)`
  );
} else {
  console.log(
    `[MCP] Project memory: no CLAUDE.md/AGENTS.md at ${workspaceRoot} — set WORKSPACE_PATH to your project root`
  );
}
if (instructionContext.git.is_repo) {
  console.log(`[MCP] Git: branch ${instructionContext.git.branch}`);
}
console.log(
  `[MCP] MCP instructions: ${Math.round(instructionContext.instructionBytes / 1024)}KB (agent prompt + env + git + memory)`
);
console.log(`[MCP] Tool profile: ${getChatGptToolProfile()} (CHATGPT_TOOL_PROFILE)`);

const sessionManager = createSessionManager({
  workspaceRoot,
  shellTimeout: SHELL_TIMEOUT,
  workspaceRoots,
  port: PORT,
  projectMemoryInstructions: instructionContext.instructionsText,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
// ChatGPT co the goi "/" hoac "/mcp" — ho tro ca hai.
// Neu dat MCP_TOKEN, endpoint doi thanh "/<token>" + "/mcp/<token>" va cac path
// khong co token se tra 401 (chong scan tunnel URL / trang web goi vao localhost).
const MCP_PATHS = [`/${MCP_TOKEN}`, `/mcp/${MCP_TOKEN}`, "/mcp"];
const MCP_PATHS_SET = new Set(MCP_PATHS);
// /health is unauthenticated, and startup output may be collected in logs.
// Keep the real token only in the route matcher, never in diagnostic output.
const DISPLAY_MCP_PATHS = MCP_TOKEN
  ? ["/[REDACTED_MCP_TOKEN]", "/mcp/[REDACTED_MCP_TOKEN]"]
  : MCP_PATHS;

app.use((req, res, next) => {
  const started = Date.now();
  const isMcpRoute = MCP_PATHS_SET.has(req.path);
  const displayPath = MCP_TOKEN ? req.path.split(MCP_TOKEN).join("[REDACTED_MCP_TOKEN]") : req.path;
  res.on("finish", () => {
    const duration = Date.now() - started;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const sessionInfo = sessionId ? ` session=${String(sessionId).slice(0, 8)}...` : "";

    if (req.method === "POST" && isMcpRoute) {
      const transportError =
        consumeSessionTransportError(sessionId) ||
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined);
      logMcpRequest(req.body, sessionId, duration, res.statusCode, transportError);
      return;
    }

    if (isMcpRoute && res.statusCode >= 400) {
      const reason =
        (typeof res.locals.mcpError === "string" ? res.locals.mcpError : undefined) ||
        (res.statusCode === 404
          ? "Session not found"
          : res.statusCode === 400
            ? "Bad Request (missing Mcp-Session-Id or invalid state)"
            : `HTTP ${res.statusCode}`);
      logMcpHttpEvent({
        method: req.method,
        path: displayPath,
        httpStatus: res.statusCode,
        durationMs: duration,
        sessionId,
        errorMessage: reason,
      });
      return;
    }

    if (!isMcpRoute) {
      console.log(`[HTTP] ${req.method} ${displayPath} ${res.statusCode} ${duration}ms${sessionInfo}`);
    }
  });
  next();
});

if (MCP_TOKEN) {
  // 404 chu KHONG phai 401: theo chuan MCP, 401 la tin hieu "can OAuth" — client
  // (ChatGPT) se di tim OAuth metadata, khong thay, roi treo. 404 = khong co gi o day.
  for (const unguarded of ["/"]) {
    app.all(unguarded, (_req, res) => {
      res.status(404).json({ ok: false, error: "Not found" });
    });
  }
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "bridge-dev",
    runtimeMode: getRuntimeMode(),
    platform: platformCapabilities(),
    workspace: workspaceRoot,
    defaultCwd: getDefaultCwd(),
    fullMachineAccess: getPolicyGate().getActiveProfile() === "dangerous",
    fullDiskAccess: getFullDiskAccess(),
    activeSessions: sessionManager.count(),
    sessionRecovery: SESSION_RECOVERY,
    mcpEndpoints: DISPLAY_MCP_PATHS,
    instructions: summarizeInstructionContext(instructionContext),
  });
});

async function handleMcpPost(req: express.Request, res: express.Response): Promise<void> {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const requestId = extractRequestId(req.body);

    const existing = sessionId ? sessionManager.get(sessionId) : undefined;
    if (existing) {
      await sessionManager.handleExisting(existing, req, res, req.body);
      return;
    }

    if (isInitializeRequest(req.body)) {
      if (sessionId) {
        console.log(`[MCP] Re-initialize with stale session header: ${sessionId}`);
      }
      await sessionManager.createNew(req, res, req.body);
      return;
    }

    if (sessionId) {
      if (SESSION_RECOVERY) {
        const recovered = await sessionManager.tryRecoverStale(
          sessionId,
          req,
          res,
          req.body
        );
        if (recovered) return;
      }
      sessionManager.sendSessionNotFound(res, requestId);
      return;
    }

    // ChatGPT gui mot so request (vd "server/discover") KHONG kem Mcp-Session-Id.
    // Tra 400 o day khien connector retry vo han ("loading mai"). Thay vao do tao
    // session moi + warm-up roi phuc vu request, de SDK tra loi JSON-RPC hop le.
    if (SESSION_RECOVERY) {
      const adopted = await sessionManager.tryRecoverStale(
        randomUUID(),
        req,
        res,
        req.body
      );
      if (adopted) return;
    }

    sessionManager.sendBadRequest(
      res,
      "Bad Request: Mcp-Session-Id header is required",
      requestId
    );
  } catch (error) {
    console.log("[MCP] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: extractRequestId(req.body),
      });
    }
  }
}

function handleStaleSession(
  req: express.Request,
  res: express.Response,
  sessionId: string | undefined
): boolean {
  if (!sessionId || sessionManager.get(sessionId)) {
    return false;
  }
  sessionManager.sendSessionNotFound(res);
  return true;
}

async function handleMcpGet(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

async function handleMcpDelete(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (handleStaleSession(req, res, sessionId)) return;

  if (!sessionId) {
    sessionManager.sendBadRequest(res, "Bad Request: Mcp-Session-Id header is required");
    return;
  }

  const session = sessionManager.get(sessionId);
  if (!session) {
    sessionManager.sendSessionNotFound(res);
    return;
  }

  await sessionManager.handleExisting(session, req, res, undefined);
}

app.use("/mcp", (req, res, next) => {
  if (req.path !== "/") return next();
  const value = req.headers.authorization?.replace(/^Bearer /, "") || "";
  const a = Buffer.from(value), b = Buffer.from(MCP_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({error:"MCP bearer token required"}); return; }
  next();
});

for (const mcpPath of MCP_PATHS) {
  app.post(mcpPath, handleMcpPost);
  app.get(mcpPath, handleMcpGet);
  app.delete(mcpPath, handleMcpDelete);
}

sessionManager.startCleanup();

const adminServer = startAdminServer({
  port: ADMIN_PORT,
  host: "127.0.0.1",
  mcpPort: PORT,
  pid: process.pid,
  manager: upstreamManager,
  sessionCount: () => sessionManager.count(),
  instructionSummary: () => summarizeInstructionContext(instructionContext),
  instructionsPreview: () => instructionContext.instructionsText,
  shutdown:()=>shutdown(),
});

const server = app.listen(PORT, HOST, () => {
  console.log("BridgeDev v2.0.0");
  console.log("Runtime : " + getRuntimeMode() + " / " + process.platform);
  console.log("Workspace : " + workspaceRoot);
  console.log("MCP : http://" + HOST + ":" + PORT + DISPLAY_MCP_PATHS[DISPLAY_MCP_PATHS.length - 1]);
  console.log("Admin : http://127.0.0.1:" + ADMIN_PORT + "/ui (authentication required)");
  console.log("Tools : " + getChatGptToolProfile());
  console.log("Stop : Ctrl-C");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error("BridgeDev failed to listen on " + HOST + ":" + PORT + ": " + err.message);
  if (err.code === "EADDRINUSE") console.error("Choose a free PORT or stop the existing gateway explicitly.");
  process.exitCode = 1;
});

let stopping = false;
async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  sessionManager.stopCleanup();
  await sessionManager.close();
  await upstreamManager.shutdown();
  adminServer.closeAllConnections();
  server.closeAllConnections();
  await Promise.all([new Promise<void>(resolve => adminServer.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]);
  process.exit(code);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
adminServer.on("error", err => { console.error("Admin listener failed: " + err.message); void shutdown(1); });
server.on("error", () => { void shutdown(1); });

// Keep an interactive foreground server alive when stdin is attached.
if (process.stdin.isTTY) {
  process.stdin.resume();
}
