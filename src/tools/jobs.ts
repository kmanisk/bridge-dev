import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { startJob, statusJob, logsJob, stopJob, listJobs } from "../lib/system-jobs.js";
import { requireWriteAllowed } from "../lib/permissions.js";

export function registerJobTools(server: McpServer, defaultCwd: string): void {
  server.registerTool("system_job", {
    title: "Durable On-Demand User Jobs",
    description: "Start/list/status/logs/stop on-demand transient systemd user jobs. Records unique unit ID, command, independent log path and durable exit code for cross-chat recovery; no new permanent service. Start and stop only at explicit user direction. Never blindly retry a timed-out start.",
    inputSchema: {
      action: z.enum(["start", "status", "logs", "stop", "list"]),
      id: z.string().optional(),
      command: z.string().optional(),
      working_directory: z.string().optional(),
      max_runtime_seconds: z.number().int().min(60).max(86400).optional().default(7200),
      max_log_bytes: z.number().int().min(200).max(100000).optional().default(10000),
      confirm_stop: z.boolean().optional().default(false),
      auth_token: z.string().optional(),
    },
    annotations: toolAnnotations("edit"),
  }, async ({ action, id, command, working_directory, max_runtime_seconds, max_log_bytes, confirm_stop, auth_token }) => {
    if (action === "list") return toolResult("system_job", await listJobs());
    if (action === "start") {
      requireWriteAllowed();
      if (!command) throw new Error("command is required for start");
      return toolResult("system_job", await startJob(command, working_directory || defaultCwd, max_runtime_seconds, auth_token));
    }
    if (!id) throw new Error("id required");
    if (action === "status") return toolResult("system_job", await statusJob(id));
    if (action === "logs") return toolResult("system_job", await logsJob(id, max_log_bytes));
    requireWriteAllowed();
    return toolResult("system_job", await stopJob(id, confirm_stop));
  });
}
