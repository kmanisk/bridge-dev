import {redactAudit} from "./hash-audit.js";
import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import { getAuditPath } from "./audit.js";

export type ActivityKind = "tool" | "mcp" | "session" | "system";

export interface ActivityEntry {
  id: string;
  time: string;
  kind: ActivityKind;
  tool?: string;
  action?: string;
  target?: string;
  status?: string;
  duration_ms?: number;
  session_id?: string;
  client?: string;
  summary?: string;
  details?: Record<string, unknown>;
}

const MAX_ENTRIES = Math.min(2000,Math.max(100,parseInt(process.env.ACTIVITY_LOG_MAX || "500",10)||500));
const entries: ActivityEntry[] = [];
const listeners = new Set<(entry: ActivityEntry) => void>();

// Ephemeral, on-demand MCP tool in-flight bookkeeping. This is NOT a ChatGPT
// task/completion detector and never persists input arguments or secrets.
type ActiveMcpTool = {request_id:string;tool:string;session_id?:string;started_at:string};
const activeTools = new Map<string,ActiveMcpTool>();
export function getActiveMcpTools():ActiveMcpTool[]{
  return [...activeTools.values()].map(x=>({...x}));
}
export function beginMcpToolRequest(body:unknown,sessionId?:string):string|undefined{
  if(!body||typeof body!=="object"||activeTools.size>=128)return undefined;
  const b=body as {method?:unknown;params?:{name?:unknown}};
  if(b.method!=="tools/call"||typeof b.params?.name!=="string"||
     !/^[a-zA-Z0-9_.:-]{1,128}$/.test(b.params.name))return undefined;
  const request_id=randomUUID(),started_at=new Date().toISOString();
  const tool=b.params.name;
  activeTools.set(request_id,{request_id,tool,session_id:sessionId,started_at});
  appendActivity({kind:"mcp",action:"tools/call",tool,session_id:sessionId,
    status:"running",details:{request_id},summary:"MCP tool request started"});
  return request_id;
}
export function completeMcpToolRequest(request_id:string,interrupted=false):void{
  const tool=activeTools.get(request_id);
  if(!tool)return;
  activeTools.delete(request_id);
  if(interrupted)appendActivity({kind:"mcp",action:"tools/call",tool:tool.tool,
    session_id:tool.session_id,status:"interrupted",summary:"MCP HTTP connection closed before response finished",
    details:{request_id}});
}


function trimSummary(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

export function summarizeToolArgs(tool: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;

  if (tool === "run_command" && typeof a.command === "string") return trimSummary(a.command, 120);
  if (typeof a.path === "string") return a.path;
  if (typeof a.server_id === "string" && typeof a.tool === "string") {
    return `${a.server_id} → ${a.tool}`;
  }
  if (typeof a.pattern === "string") return `pattern: ${a.pattern}`;
  if (typeof a.checkpoint_id === "string") return `checkpoint: ${a.checkpoint_id}`;
  if (typeof a.action === "string") return `action: ${a.action}`;

  try {
    return trimSummary(JSON.stringify(a));
  } catch {
    return "";
  }
}

export function appendActivity(partial: Omit<ActivityEntry, "id" | "time"> & { time?: string }): ActivityEntry {
  const entry: ActivityEntry = {
    id: randomUUID(),
    time: partial.time ?? new Date().toISOString(),
    ...(redactAudit(partial) as typeof partial),
  };

  if(JSON.stringify(entry.details||{}).length>65536)entry.details={truncated:true,note:"Activity detail exceeds 64 KiB; use the tool result or durable audit record"};
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();

  writeConsole(entry);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {}
  }
  return entry;
}

export function subscribeActivity(listener: (entry: ActivityEntry) => void): () => void {
  if(listeners.size>=16)throw new Error("ACTIVITY_SUBSCRIBER_LIMIT");
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecentActivity(limit = 100, sinceId?: string): ActivityEntry[] {
  const capped = Math.min(Math.max(limit, 1), MAX_ENTRIES);
  if (!sinceId) return [...entries].slice(-capped).reverse();
  const idx = entries.findIndex((e) => e.id === sinceId);
  if (idx < 0) return [...entries].slice(-capped).reverse();
  return entries.slice(idx + 1).reverse();
}

function writeConsole(entry: ActivityEntry): void {
  const sid = entry.session_id ? ` session=${entry.session_id.slice(0, 8)}` : "";
  const dur = entry.duration_ms != null ? ` ${entry.duration_ms}ms` : "";
  const isError = entry.status === "error" || entry.status === "blocked";

  if (isError) {
    const label =
      entry.tool ? `tools/call ${entry.tool}` : entry.action || entry.kind || "mcp";
    const detail = entry.summary || entry.target || "";
    const http = entry.details?.http_status != null ? ` HTTP ${entry.details.http_status}` : "";
    console.warn(
      `[MCP ERROR]${http} ${label}${detail ? ` — ${detail}` : ""}${dur}${sid}`
    );
    return;
  }

  const status = entry.status ? ` [${entry.status}]` : "";

  if (entry.kind === "tool" && entry.tool) {
    const extra = entry.summary || entry.target || "";
    console.log(`[TOOL]${status} ${entry.tool}${extra ? ` — ${extra}` : ""}${dur}${sid}`);
    return;
  }

  if (entry.kind === "mcp") {
    const label = entry.tool ? `tools/call ${entry.tool}` : entry.action || "request";
    const extra = entry.summary ? ` — ${entry.summary}` : "";
    const discovery =
      entry.action === "tools/list" && entry.details?.tool_count != null
        ? ` (${entry.details.tool_count} tools)`
        : "";
    console.log(`[MCP]${status} ${label}${discovery}${extra}${dur}${sid}`);
    return;
  }

  if (entry.kind === "session") {
    const extra = entry.summary ? ` — ${entry.summary}` : "";
    console.log(`[MCP] session ${entry.action || "event"}${extra}${sid}`);
    return;
  }
}

export async function loadAuditHistory(limit = 80): Promise<ActivityEntry[]> {
  const auditPath = getAuditPath();
  try {
    const raw = await fs.readFile(auditPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map((line) => {
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        return {
          id: randomUUID(),
          time: String(rec.time || new Date().toISOString()),
          kind: "tool" as const,
          tool: String(rec.tool || "unknown"),
          action: String(rec.action || ""),
          target: rec.target ? String(rec.target) : undefined,
          status: rec.status ? String(rec.status) : undefined,
          details: rec.details as Record<string, unknown> | undefined,
          summary: rec.target ? String(rec.target) : undefined,
        };
      } catch {
        return {
          id: randomUUID(),
          time: new Date().toISOString(),
          kind: "system" as const,
          summary: line.slice(0, 200),
        };
      }
    }).reverse();
  } catch {
    return [];
  }
}

export function logMcpHttpEvent(opts: {
  method: string;
  path: string;
  httpStatus: number;
  durationMs: number;
  sessionId?: string;
  rpcMethod?: string;
  tool?: string;
  errorMessage?: string;
  summary?: string;
}): void {
  const isError = opts.httpStatus >= 400;
  const label = opts.tool
    ? `tools/call ${opts.tool}`
    : opts.rpcMethod || `${opts.method} ${opts.path}`;
  const summary =
    opts.errorMessage ||
    opts.summary ||
    (isError ? `HTTP ${opts.httpStatus}` : undefined);

  appendActivity({
    kind: opts.rpcMethod === "initialize" ? "session" : "mcp",
    tool: opts.tool,
    action: opts.rpcMethod || `${opts.method} ${opts.path}`,
    session_id: opts.sessionId,
    client: "chatgpt",
    status: isError ? "error" : "ok",
    duration_ms: opts.durationMs,
    summary,
    details: { http_status: opts.httpStatus, method: opts.method, path: opts.path },
  });
}

export function logMcpRequest(
  body: unknown,
  sessionId: string | undefined,
  durationMs: number,
  httpStatus: number,
  errorMessage?: string,
  requestId?: string
): void {
  if (typeof body !== "object" || body === null) {
    if (httpStatus >= 400) {
      logMcpHttpEvent({
        method: "POST",
        path: "/mcp",
        httpStatus,
        durationMs,
        sessionId,
        errorMessage,
      });
    }
    return;
  }
  const rpc = body as { method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
  const isError = httpStatus >= 400;
  const argSummary =
    rpc.method === "tools/call" && rpc.params?.name
      ? summarizeToolArgs(rpc.params.name, rpc.params.arguments)
      : undefined;
  const summary = errorMessage || argSummary;

  if (rpc.method === "tools/call" && rpc.params?.name) {
    const tool = rpc.params.name;
    appendActivity({
      kind: "mcp",
      tool,
      action: "tools/call",
      session_id: sessionId,
      client: "chatgpt",
      status: isError ? "error" : "ok",
      duration_ms: durationMs,
      summary,
      details: {
        http_status: httpStatus,
        ...(requestId ? {request_id:requestId} : {}),
        arguments: rpc.params.arguments,
        ...(errorMessage ? { error: errorMessage } : {}),
      },
    });
    return;
  }

  if (rpc.method === "initialize") {
    appendActivity({
      kind: "session",
      action: "initialize",
      session_id: sessionId,
      client: "chatgpt",
      status: isError ? "error" : "ok",
      duration_ms: durationMs,
      summary: errorMessage,
      details: { http_status: httpStatus },
    });
    return;
  }

  if (rpc.method === "tools/list") {
    appendActivity({
      kind: "mcp",
      action: "tools/list",
      session_id: sessionId,
      client: "chatgpt",
      status: isError ? "error" : "ok",
      duration_ms: durationMs,
      summary: errorMessage || (isError ? `HTTP ${httpStatus}` : "discovery"),
      details: { http_status: httpStatus, phase: "connector_discovery" },
    });
    return;
  }

  if (rpc.method && !rpc.method.startsWith("notifications/")) {
    appendActivity({
      kind: "mcp",
      action: rpc.method,
      session_id: sessionId,
      client: "chatgpt",
      status: isError ? "error" : "ok",
      duration_ms: durationMs,
      summary: errorMessage,
      details: { http_status: httpStatus },
    });
  }
}