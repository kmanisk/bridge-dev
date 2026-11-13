import { appendActivity } from "./activity-log.js";
import { getPolicyGate } from "./policy-gateway.js";

export type AuditStatus = "ok" | "error" | "blocked" | "dry-run";
export interface AuditEvent {
  tool: string;
  action: string;
  target?: string;
  status?: AuditStatus;
  details?: Record<string, unknown>;
}

/**
 * Hash-chain audit for all legacy tool events. Never swallow write failures:
 * the gateway separately records an authorized decision before a handler runs.
 */
export async function audit(event: AuditEvent): Promise<void> {
  await getPolicyGate().audit.append({ phase:"legacy_event", pid:process.pid, ...event });
  try {
    appendActivity({
      kind:"tool",
      tool:event.tool,
      action:event.action,
      target:event.target,
      status:event.status??"ok",
      summary:event.target || (event.details?JSON.stringify(event.details).slice(0,120):undefined),
      details:event.details,
    });
  } catch {
    // Best-effort presentation only. The durable hash ledger was synced above.
  }
}
export function getAuditPath(): string { return getPolicyGate().config.audit_log; }
