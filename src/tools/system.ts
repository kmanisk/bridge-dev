import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSystemDocuments, type SystemDocKey } from "../lib/system-context.js";
import { inspectSections, INSPECTION_SECTIONS, type InspectionSection } from "../lib/system-inspect.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult, TOOL_RESULT_OUTPUT_SCHEMA } from "../lib/tool-result.js";

const systemDocNames = ["agents", "current_state", "philosophy", "subsystem_map", "local_coder", "control_plane"] as const;
const sections = ["resources", "gpu", "storage", "services", "sway", "audio", "bluetooth", "drift"] as const;

export function registerSystemTools(server: McpServer): void {
  server.registerTool("system_context", {
    title: "Optional Host System Context",
    description: "Load managed host context before commands or writes. When configured, returns context_token and context_expires_at; use the short-lived token on subsequent calls if your client does not retain Mcp-Session-Id. Reload on expiry or document changes. It never grants sudo/operator approval. Portable installs return not-configured.",
    inputSchema: {
      docs: z.array(z.enum(systemDocNames)).optional().default(["agents", "current_state", "philosophy", "subsystem_map"]),
      max_bytes_each: z.number().int().positive().max(100000).optional().default(12000),
      detailed_paths: z.array(z.string()).max(8).optional().default([]).describe("Owning Markdown docs under canonical docs/, e.g. docs/system/sway.md. Paths outside docs/ are refused."),
    },
    annotations: toolAnnotations("read"),
    outputSchema: {
      ...TOOL_RESULT_OUTPUT_SCHEMA,
      data: z.object({
        context_token: z.string().max(2048).optional().describe("Short-lived context proof for clients without session continuity; pass into context_token on subsequent gated tools. Treat as a secret."),
        context_expires_at: z.number().optional().describe("Expiry as epoch milliseconds; reload system_context when expired or after context changes."),
      }).catchall(z.unknown()),
    },
  }, async ({ docs, max_bytes_each, detailed_paths }) =>
    toolResult("system_context", await getSystemDocuments(docs as SystemDocKey[], max_bytes_each, detailed_paths))
  );

  server.registerTool("system_inspect", {
    title: "Optional Linux System Inspector",
    description: "Optional Linux diagnostics. Unsupported platforms and unavailable sections report explicit limitations.",
    inputSchema: {
      sections: z.array(z.enum(sections)).min(1).max(8).optional().default(["resources", "services"]),
    },
    annotations: toolAnnotations("read"),
  }, async ({ sections: desired }) =>
    toolResult("system_inspect", await inspectSections(desired as InspectionSection[]))
  );
}
