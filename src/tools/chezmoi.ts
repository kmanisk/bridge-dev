import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { inspectChezmoiPath } from "../lib/chezmoi-guard.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { audit } from "../lib/audit.js";

export function registerChezmoiTools(server: McpServer): void {
  server.registerTool(
    "chezmoi_inspect",
    {
      title: "Inspect Chezmoi Ownership",
      description: "Read-only: resolve a live path to its canonical chezmoi source, detect generated/unmanaged targets, and report source Git status. Never applies or edits configuration.",
      inputSchema: { path: z.string() },
      annotations: toolAnnotations("read"),
    },
    async ({ path: requestedPath }) => {
      const validPath = await validatePath(requestedPath);
      const inspection = await inspectChezmoiPath(validPath);
      await audit({ tool: "chezmoi_inspect", action: "inspect", target: validPath, status: "ok", details: { kind: inspection.kind } });
      return toolResult("chezmoi_inspect", inspection, {
        ok: inspection.kind !== "unavailable",
        summary: inspection.kind + ": " + (inspection.sourcePath || validPath),
      });
    }
  );
}
