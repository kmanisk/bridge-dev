import {safeEnvironment,saveSafeEnvironment} from "../lib/safe-environment.js";
import {getLocalToolOverrides,saveLocalToolOverrides} from "../lib/tool-profile.js";
import {runtimeVersion} from "../lib/service-config.js";
import {fetchLatestMainSha} from "../lib/release-notice.js";
import {getPolicyGate} from "../lib/policy-gateway.js";
import {getRuntimeMode} from "../lib/runtime.js";
import {redactAudit} from "../lib/hash-audit.js";
import {tailscaleEndpoint} from "../lib/tailscale.js";
import fs from "fs/promises";
import path from "path";
import { Router, type Request, type Response } from "express";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import {
  defaultUpstreamConfig,
  discoverMcpConfigs,
  findMcpConfigForSource,
  importMcpConfigFromFile,
  type McpImportSource,
  type UpstreamServerConfig,
} from "../lib/mcp-upstream-config.js";
import { getDefaultCwd, getFullDiskAccess } from "../lib/path-security.js";
import { getCheckpointConfig } from "../lib/checkpoint.js";
import { getLocalPluginsConfig, saveLocalPluginsConfig } from "../lib/plugin-config.js";
import { getCodexHooks, saveCodexHooks } from "../lib/codex-hooks.js";
import {
  getRecentActivity,
  getActiveMcpTools,
  loadAuditHistory,
  subscribeActivity,
  type ActivityEntry,
} from "../lib/activity-log.js";

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

export function createAdminRouter(manager: McpUpstreamManager, options: {
  mcpPort: number;
  pid: number;
  sessionCount: () => number;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
}): Router {
  const router = Router();
  const envPath = path.resolve(process.env.DOTENV_CONFIG_PATH || path.join(process.cwd(), ".env"));

  router.get("/health", async (_req: Request, res: Response) => {
    const upstream = manager.listStatusesCached();
    res.json({
      status: "ok",
      name: "bridge-dev-admin",
      ...runtimeVersion(),
      uptime_seconds: Math.floor(process.uptime()),
      runtime_mode:getRuntimeMode(),
      policy_mode:getPolicyGate().getActiveProfile(),
      full_machine_access:getPolicyGate().getActiveProfile()==="dangerous",
      pid: options.pid,
      mcp_port: options.mcpPort,
      active_sessions: options.sessionCount(),
      default_cwd: getDefaultCwd(),
      full_disk_access: getFullDiskAccess(),
      public_url: tailscaleEndpoint(options.mcpPort),
      upstream,
      checkpoint: getCheckpointConfig(),
      instructions: options.instructionSummary?.() ?? null,
    });
  });

  // Explicit operator-requested check only. Never poll GitHub or trigger a
  // deployment from the Admin dashboard; no MCP token or Admin token is sent.
  router.get("/api/update/check", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const installed = runtimeVersion().commit;
      const latest = await fetchLatestMainSha();
      res.json({ ok: true, data: {
        installed_commit: installed,
        main_commit: latest,
        update_available: installed ? installed !== latest : null,
        update_command: "bridge-dev update",
        checked_at: new Date().toISOString(),
      }});
    } catch {
      res.status(503).json({ ok: false, error: "UPDATE_CHECK_UNAVAILABLE: inspect network access and try later" });
    }
  });

  // Credentials are returned only by this authenticated, explicit connection view.
  router.get("/api/access", (_req, res) => {
    res.setHeader("Cache-Control","no-store");
    res.json({mcp_token:process.env.MCP_TOKEN || ""});
  });

  router.get("/api/instructions/preview", (_req, res) => {
    const text = options.instructionsPreview?.() ?? "";
    const summary = options.instructionSummary?.() ?? {};
    res.json({
      ok: true,
      summary,
      preview: text.slice(0, 12000),
      truncated: text.length > 12000,
      total_chars: text.length,
    });
  });

  router.get("/api/config/env", async (_req, res) => {
    try {
      const text = await fs.readFile(envPath, "utf-8");
      res.json({ ok: true, path: envPath, values: redactAudit({...parseDotEnv(text),...safeEnvironment()}) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.json({ ok: true, path: envPath, values:safeEnvironment() });
        return;
      }
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.put("/api/config/env", async (req, res) => {
    try {
      const values = req.body?.values as Record<string, string>;
      if(values && Object.entries(values).some(([key,value])=>!/^[_A-Z][_A-Z0-9]*$/.test(key)||typeof value!=="string"||/[\r\n\0]/.test(value))){res.status(400).json({error:"Environment values must be single-line strings with safe variable names"});return;}
      if (values && Object.keys(values).some(key => /^(POLICYGATE_|BRIDGEDEV_|MCP_UPSTREAM_CONFIG$|POST_EDIT_HOOKS_CONFIG$|WORKSPACE_PATH$|EXTRA_WORKSPACE_PATHS$|SECURITY_MODE$|AUDIT_LOG_PATH$|MCP_TOKEN$|ADMIN_TOKEN$|CHATGPT_AUTO_APPROVE$)/.test(key))) {
        res.status(403).json({ok:false,error:"POLICYGATE_ADMIN_IMMUTABLE: security, dangerous-mode, approval, audit and authentication settings require an offline operator configuration change and restart."});
        return;
      }
      if (!values || typeof values !== "object") {
        res.status(400).json({ ok: false, error: "values object required" });
        return;
      }
      await getPolicyGate().audit.append({phase:"operator_safe_settings",keys:Object.keys(values)});
      saveSafeEnvironment(values);
      res.json({ok:true,credential_source_unchanged:true,restart_required:"Use bridge-dev service restart to apply runtime settings; credentials and policy are offline-only."});
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/api/upstream", async (_req, res) => {
    res.json({ ok: true, config: redactAudit(manager.getConfig()), configuration:manager.configuration, path: manager.getConfigPath() });
  });

  router.get("/api/plugins", (_req, res) => {
    res.json({ ok: true, config: getLocalPluginsConfig(), available: { computer_use: process.platform === "win32" } });
  });

  router.put("/api/plugins", (req, res) => {
    const computerUseEnabled = req.body?.config?.computer_use?.enabled === true;
    const next = { computer_use: { enabled: computerUseEnabled } };
    saveLocalPluginsConfig(next);
    res.json({ ok: true, config: next, restart_required: "Open a new ChatGPT MCP session after changing plugin state." });
  });

  router.get("/api/codex-hooks", async (_req, res) => {
    try {
      res.json({ ok: true, hooks: await getCodexHooks() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/codex-hooks", async (req, res) => {
    try {
      res.json({ ok: true, hooks: await saveCodexHooks(req.body?.enabled) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/local-tools", async (_req, res) => {
    try {
      const { LOCAL_TOOL_CATALOG } = await import("../lib/tool-profile.js");
      const overrides=getLocalToolOverrides();
      res.json({ ok: true, tools: LOCAL_TOOL_CATALOG, overrides });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/local-tools", async (req, res) => {
    try {
      const { LOCAL_TOOL_CATALOG } = await import("../lib/tool-profile.js");
      const known = new Set(LOCAL_TOOL_CATALOG);
      const names = (value: unknown) => Array.isArray(value)
        ? [...new Set(value.filter((name): name is string => typeof name === "string" && known.has(name)))]
        : [];
      const enabled = names(req.body?.overrides?.enabled);
      const disabled = names(req.body?.overrides?.disabled).filter((name) => !enabled.includes(name));
      saveLocalToolOverrides({enabled,disabled});
      res.json({ ok: true, overrides: { enabled, disabled }, restart_required: "Open a new ChatGPT MCP session after changing local tool visibility." });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/upstream", async (req, res) => {
    try {
      const config = req.body?.config ?? defaultUpstreamConfig();
      const saved = await manager.updateConfig(config);
      res.json({ ok: true, config: saved });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream", async (req, res) => {
    try {
      const server = req.body?.server as UpstreamServerConfig;
      if (!server?.id) {
        res.status(400).json({ ok: false, error: "server.id required" });
        return;
      }
      await manager.upsertServer(server);
      res.json({ ok: true, config: redactAudit(manager.getConfig()) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/upstream/:id", async (req, res) => {
    const removed = await manager.removeServer(req.params.id);
    if (!removed) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    res.json({ ok: true, config: redactAudit(manager.getConfig()) });
  });

  router.post("/api/upstream/:id/test", async (req, res) => {
    try {
      const status = await manager.checkHealth(req.params.id);
      res.json({ ok: status.health === "connected", status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/upstream/:id/oauth/status", async (req, res) => {
    try {
      res.json({ ok: true, status: await manager.oauthStatus(req.params.id) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream/:id/oauth/start", async (req, res) => {
    try {
      const status = await manager.startOAuth(req.params.id, req.body?.reset !== false);
      res.json({ ok: true, status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream/:id/oauth/disconnect", async (req, res) => {
    try {
      await manager.disconnectOAuth(req.params.id);
      res.json({ ok: true, status: await manager.oauthStatus(req.params.id) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/upstream/:id/tools", async (req, res) => {
    try {
      const tools = manager.inspectCachedTools(req.params.id);
      const config = manager.getServerConfig(req.params.id);
      res.json({
        ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        proxied_tools: config ? manager.getProxiedToolNames(config, tools) : [],
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/import/sources", async (_req, res) => {
    try {
      const sources = await discoverMcpConfigs();
      res.json({ ok: true, sources });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function handleImport(
    source: McpImportSource,
    body: { path?: string; merge?: boolean; enable?: boolean }
  ) {
    const configPath = body.path || (await findMcpConfigForSource(source));
    if (!configPath) throw new Error(`${source} MCP config not found on this machine`);
    return importMcpConfigFromFile(configPath, source, {
      merge: body.merge !== false,
      enableImported: Boolean(body.enable),
    });
  }

  router.post("/api/import/:source", async (req, res) => {
    try {
      const source = req.params.source as McpImportSource;
      if (!["cursor", "claude", "opencode", "file"].includes(source)) {
        res.status(400).json({ ok: false, error: "Unknown import source" });
        return;
      }
      const filePath = req.body?.path as string | undefined;
      if (source === "file" && !filePath) {
        res.status(400).json({ ok: false, error: "path required for file import" });
        return;
      }
      const detectSource: McpImportSource =
        source === "file" ? (req.body?.detect_as as McpImportSource) || "cursor" : source;
      const result = await importMcpConfigFromFile(filePath || (await findMcpConfigForSource(source))!, detectSource, {
        merge: req.body?.merge !== false,
        enableImported: Boolean(req.body?.enable),
      });
      await manager.reloadConfig();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/import/cursor", async (req, res) => {
    try {
      const result = await handleImport("cursor", req.body ?? {});
      await manager.reloadConfig();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  function filterActivity(
    entries: ActivityEntry[],
    opts: { kind?: string; status?: string; tool?: string; q?: string }
  ): ActivityEntry[] {
    let out = entries;
    if (opts.kind && opts.kind !== "all") {
      out = out.filter((e) => e.kind === opts.kind);
    }
    if (opts.status === "error") {
      out = out.filter((e) => e.status === "error" || e.status === "blocked");
    }
    if (opts.tool) {
      const needle = opts.tool.toLowerCase();
      out = out.filter((e) => e.tool?.toLowerCase().includes(needle));
    }
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      out = out.filter((e) => {
        const hay = [e.tool, e.action, e.target, e.summary, e.client, e.session_id]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }
    return out;
  }

  router.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const entries = filterActivity(getRecentActivity(limit, since), {
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      tool: typeof req.query.tool === "string" ? req.query.tool : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
    });
    res.json({ ok: true, entries, count: entries.length, active:getActiveMcpTools() });
  });

  router.get("/api/activity/history", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "80"), 10) || 80, 500);
      const entries = await loadAuditHistory(limit);
      res.json({ ok: true, entries, source: "audit_file" });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/activity/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (entry: ActivityEntry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    for (const entry of getRecentActivity(30).reverse()) send(entry);

    const unsub = subscribeActivity(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      unsub();
      clearInterval(ping);
    });
  });

  return router;
}
