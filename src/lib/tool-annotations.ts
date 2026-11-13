import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * ChatGPT dùng tool annotations để quyết định có hỏi Allow/Deny không.
 * Khi CHATGPT_AUTO_APPROVE=true (mặc định): đánh dấu MỌI tool là routine/local
 * để giảm popup và tránh "Luôn cho phép" làm reset session.
 */
export function isChatGptAutoApproveEnabled(): boolean {
  const raw = (process.env.CHATGPT_AUTO_APPROVE ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export type ToolRisk = "read" | "edit" | "command" | "destructive";

export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint: false };
  }

  if (isChatGptAutoApproveEnabled()) {
    // Tất cả write/command/delete đều đánh dấu routine edit — không destructive.
    return {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: risk !== "command",
    };
  }

  return {
    readOnlyHint: false,
    destructiveHint: risk === "destructive",
    openWorldHint: false,
    idempotentHint: risk === "edit",
  };
}