import { Router, type Request, type Response } from "express";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { z } from "zod";
import { serviceStatus } from "../lib/service-config.js";
import { getPolicyGate } from "../lib/policy-gateway.js";
import { verifyAuditFile, redactAudit } from "../lib/hash-audit.js";
import { ExtensionStore } from "../lib/extension-store.js";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
/** Authenticated operator routes only. This router is never mounted on MCP. */
export function operationsRouter(manager: McpUpstreamManager): Router {
  const r = Router(),
    store = new ExtensionStore(undefined, undefined, manager);
  const run =
    (fn: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.json(redactAudit(await fn(req)));
      } catch {
        res.status(400).json({
          ok: false,
          error:
            "OPERATOR_INSPECTION_FAILED: inspect local diagnostics; no changes applied",
        });
      }
    };
  r.get(
    "/api/service/status",
    run(() => serviceStatus()),
  );
  r.post(
    "/api/service/events",
    run(async (req) => {
      const event = z
        .object({
          operation: z.enum(["update", "rollback", "adopt"]),
          job: z.string().uuid(),
          outcome: z.enum([
            "success",
            "shadow_accepted",
            "positive_smoke_passed",
            "accepted_before_legacy_restart",
          ]),
          from: z.string().regex(/^[a-f0-9]{40}$/).optional(),
          to: z.string().regex(/^[a-f0-9]{40}$/).optional(),
          checks: z.record(z.string(), z.unknown()).optional(),
          lease: z.string().optional(),
        })
        .passthrough()
        .parse(req.body);
      await getPolicyGate().audit.append({
        phase: "service_operation",
        actor: "operator-cli",
        ...event,
      });
      return { ok: true };
    }),
  );
  r.get(
    "/api/audit",
    run(async (req) => {
      await getPolicyGate().audit.flush();
      const filename = getPolicyGate().audit.filename,
        integrity = verifyAuditFile(filename);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50)),
        offset = Math.max(0, Math.min(100000, Number(req.query.offset) || 0));
      const filter = String(req.query.filter || "")
        .slice(0, 256)
        .toLowerCase();
      // Read only on explicit refresh; never rotate or rewrite the protected ledger.
      const rows: unknown[] = [];
      let total = 0;
      const scan = async (visitor: (row: any, index: number) => void) => {
        const input = createReadStream(filename),
          lines = createInterface({ input, crlfDelay: Infinity });
        let inspected = 0,
          matched = 0;
        try {
          for await (const line of lines) {
            if (!line) continue;
            if (inspected++ >= integrity.entries) break;
            const row = redactAudit(JSON.parse(line)) as any;
            const encoded = JSON.stringify(row);
            if (filter && !encoded.toLowerCase().includes(filter)) continue;
            visitor(
              encoded.length > 16384
                ? {
                    time: row.time,
                    actor: row.actor,
                    phase: row.phase,
                    outcome: row.outcome,
                    truncated: true,
                    preview: encoded.slice(0, 16000),
                  }
                : row,
              matched++,
            );
          }
        } finally {
          lines.close();
          input.destroy();
        }
      };
      if (integrity.entries) {
        await scan(() => {
          total++;
        });
        const first = Math.max(0, total - offset - limit),
          last = total - offset;
        await scan((row, index) => {
          if (index >= first && index < last) rows.push(row);
        });
      }
      return {
        ok: true,
        integrity: { ok: true, entries: integrity.entries },
        total,
        offset,
        limit,
        entries: rows.reverse(),
      };
    }),
  );
  r.get(
    "/api/extensions/proposals",
    run(async () => {
      const names = await fs
          .readdir(path.join(store.root, "proposals"))
          .catch(() => []),
        proposals = [];
      for (const name of names
        .filter((x) => /^[a-f0-9]{64}\.json$/.test(x))
        .slice(0, 100)) {
        try {
          proposals.push(await store.proposal(name.slice(0, -5)));
        } catch {
          /* expired or another workspace; never approve here */
        }
      }
      return {
        proposals,
        requests: await store.requests(),
        native_approvals:
          "Signed native command approvals require the independent operator CLI; this page cannot sign them.",
      };
    }),
  );
  r.get(
    "/api/extensions/content",
    run((req) => store.content(String(req.query.key || ""))),
  );
  r.post(
    "/api/extensions/reject",
    run(async (req) => {
      const { id } = z
        .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(req.body);
      await store.reject(id);
      await getPolicyGate().audit.append({
        phase: "operator_extension_rejection",
        id,
      });
      return { ok: true };
    }),
  );
  return r;
}
