import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSystemDocuments, type SystemDocKey } from "../lib/system-context.js";
import { inspectSections, INSPECTION_SECTIONS, type InspectionSection } from "../lib/system-inspect.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

const systemDocNames = ["agents", "current_state", "philosophy", "subsystem_map", "local_coder", "control_plane"] as const;
const sections = ["resources", "gpu", "storage", "services", "sway", "audio", "bluetooth", "drift"] as const;

export function registerSystemTools(server: McpServer): void {
  server.registerTool("system_context", {
    title: "Canonical Linux System Context",
    description: "One-call bootstrap for Linux system tasks: live kmanisk/dots AGENTS.md rules, verified SYSTEM_CONTEXT.md, system philosophy, subsystem map and relevant detailed docs. Read before any system change; refreshes after documentation edits, unlike startup instructions. Does not change anything.",
    inputSchema: {
      docs: z.array(z.enum(systemDocNames)).optional().default(["agents", "current_state", "philosophy", "subsystem_map"]),
      max_bytes_each: z.number().int().positive().max(100000).optional().default(12000),
      detailed_paths: z.array(z.string()).max(8).optional().default([]).describe("Owning Markdown docs under canonical docs/, e.g. docs/system/sway.md. Paths outside docs/ are refused."),
    },
    annotations: toolAnnotations("read"),
  }, async ({ docs, max_bytes_each, detailed_paths }) =>
    toolResult("system_context", await getSystemDocuments(docs as SystemDocKey[], max_bytes_each, detailed_paths))
  );

  server.registerTool("system_inspect", {
    title: "Linux System Inspector",
    description: "Compact read-only JSON diagnostics without numerous shell calls. Select resource usage, NVIDIA GPU, storage, failed services, Sway focused window and outputs, PipeWire audio, Bluetooth event logs, or chezmoi/git drift with documentation routing. Unavailable sections are reported rather than guessed.",
    inputSchema: {
      sections: z.array(z.enum(sections)).min(1).max(8).optional().default(["resources", "services"]),
    },
    annotations: toolAnnotations("read"),
  }, async ({ sections: desired }) =>
    toolResult("system_inspect", await inspectSections(desired as InspectionSection[]))
  );
}
