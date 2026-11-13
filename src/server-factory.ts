import {registerExtensionTools} from "./tools/extensions.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerChezmoiTools } from "./tools/chezmoi.js";
import { registerSystemTools } from "./tools/system.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerContextTools } from "./tools/context.js";
import { registerRewindTools } from "./tools/rewind.js";
import { registerMcpBridgeTools } from "./tools/mcp-bridge.js";
import { registerNodeReplTool } from "./tools/node-repl.js";
import { registerPonytailTurnTool } from "./tools/ponytail.js";
import { buildServerInstructions } from "./lib/quickstart.js";
import type { McpUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { getChatGptToolProfile, shouldExposeTool } from "./lib/tool-profile.js";
import { TOOL_RESULT_OUTPUT_SCHEMA } from "./lib/tool-result.js";
import { getPolicyGate, newPolicySession, type PolicySession } from "./lib/policy-gateway.js";

const NOOP_TOOL = {
  remove: () => {},
  update: () => {},
  enable: () => {},
  disable: () => {},
  handler: async () => ({ content: [] }),
  enabled: false,
} as unknown as RegisteredTool;

function configureToolRegistration(server: McpServer, session: PolicySession): void {
  const gate = getPolicyGate();
  const profile = getChatGptToolProfile();
  const original = server.registerTool.bind(server);
  server.registerTool = ((name, config, callback) => {
    const toolName = String(name);
    const isUpstreamProxy = toolName.includes("__");
    gate.register(toolName);

    // Upstream MCP tools are namespaced as <server>__<tool>. An enabled
    // upstream is always exposed directly, even when local tools use slim.
    if (!isUpstreamProxy && profile !== "full" && !shouldExposeTool(toolName, profile)) {
      return NOOP_TOOL;
    }

    // Every native Local Coder tool already returns the stable
    // { ok, tool, summary, data } structuredContent envelope. Advertise that
    // contract so MCP clients (including ChatGPT) can validate/use structured
    // output instead of treating every result as opaque text.
    const nextConfig =
      !isUpstreamProxy && !config.outputSchema
        ? { ...config, outputSchema: TOOL_RESULT_OUTPUT_SCHEMA }
        : config;

    return original(name, nextConfig as any, (async (...callArgs: unknown[]) => {
      const args = (callArgs[0] && typeof callArgs[0] === "object" ? callArgs[0] : {}) as Record<string, unknown>;
      await gate.audit.append({phase:"request",tool:toolName,session_id:session.id,args});
      try {
        const decision=await gate.authorize(session,toolName,args);
        await gate.audit.append({phase:"decision",status:"allowed",tool:toolName,session_id:session.id,class:decision.kind});
        if (!isUpstreamProxy && (decision.requiresApproval || gate.getActiveProfile() === "dangerous") && !args.auth_token) {
          const { getSecurityPolicy } = await import("./lib/security-policy.js");
          const policy = getSecurityPolicy();
          args.auth_token = policy.createAuthorization({
            operationClass: "high_risk",
            command: typeof args.command === "string" ? args.command : undefined,
            targetPath: typeof args.path === "string" ? args.path : (typeof args.file === "string" ? args.file : undefined),
            maxUses: 1,
            ttlMs: 60000,
            origin: "user_approval",
          });
        }
      } catch (error) {
        await gate.audit.append({phase:"decision",status:"denied",tool:toolName,session_id:session.id,reason:String(error)});
        throw error;
      }
      try {
        const result=await (callback as (...a: unknown[]) => Promise<any>)(...callArgs);
        if(toolName==="system_context" && !result?.isError && result?.structuredContent?.ok!==false) {
          await gate.contextLoaded(session,args);
        }
        await gate.audit.append({phase:"result",status:result?.isError||result?.structuredContent?.ok===false?"error":"ok",tool:toolName,session_id:session.id});
        return result;
      } catch (error) {
        await gate.audit.append({phase:"result",status:"error",tool:toolName,session_id:session.id,error:String(error)});
        throw error;
      }
    }) as any);
  }) as typeof server.registerTool;
}

export function createMcpServer(
  workspaceRoot: string,
  shellTimeout: number,
  workspaceRoots: string[] = [workspaceRoot],
  fullDiskAccess = false,
  upstreamManager?: McpUpstreamManager,
  projectMemoryInstructions?: string,
  policySession: PolicySession = newPolicySession()
): McpServer {
  const server = new McpServer(
    {
      name: "bridge-dev",
      version: "2.0.0",
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
      },
      instructions: buildServerInstructions(
        workspaceRoot,
        workspaceRoots,
        fullDiskAccess,
        projectMemoryInstructions
      ),
    }
  );

  configureToolRegistration(server, policySession);

  registerFilesystemTools(server);
  registerChezmoiTools(server);
  registerSystemTools(server);
  registerJobTools(server, workspaceRoot);
  registerShellTools(server, workspaceRoot, shellTimeout);
  registerGitTools(server, workspaceRoot);
  registerContextTools(server, workspaceRoot);
  registerNodeReplTool(server, workspaceRoot);
  registerPonytailTurnTool(server);
  registerRewindTools(server);

  if (upstreamManager) {
    registerMcpBridgeTools(server, upstreamManager);
    registerExtensionTools(server,workspaceRoot,upstreamManager);
    upstreamManager.registerMcpServer(server);
  }

  // Assert the complete native inventory even in direct/in-memory sessions
  // without an upstream manager. Newly added native tools fail at registration;
  // removed or missing registrations fail here before a server is returned.
  getPolicyGate().assertComplete(Boolean(upstreamManager));

  return server;
}
