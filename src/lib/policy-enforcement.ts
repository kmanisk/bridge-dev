import fs from "node:fs";
import type { PolicyGate, PolicySession, PolicyAuthorization } from "./policy-gateway.js";
import { classifyTool } from "./tool-classification.js";
import { checkPath, pathsFromArgs } from "./policy-paths.js";
import { analyzeCommand } from "./policy-commands.js";
import { ApprovalStore } from "./policy-approvals.js";
import { getShellStatus } from "./persistent-shell.js";
import { inspectChezmoiPath } from "./chezmoi-guard.js";
import { postEditHooksConfigPath } from "./post-edit-hooks.js";

const REDIRECTABLE_EDIT_TOOLS = new Set([
  "write_file", "write_file_base64", "edit_file", "multi_edit", "replace_regex", "apply_patch",
]);

const approvals = new WeakMap<PolicyGate,ApprovalStore>();
function store(gate:PolicyGate):ApprovalStore {
  let value=approvals.get(gate);
  if(!value){value=new ApprovalStore(gate.config.audit_log);approvals.set(gate,value);}
  return value;
}
function deny(session:PolicySession,gate:PolicyGate,message:string,contextOnly=false):never {
  if(!contextOnly) {
    session.consecutiveDenials++;
    if(session.consecutiveDenials >= gate.config.limits.max_denials) session.locked = true;
  }
  throw new Error(message + (session.locked?" POLICYGATE_SESSION_LOCKED: ask the operator to unlock the session.":""));
}
export async function enforcePolicy(gate:PolicyGate,session:PolicySession,tool:string,args:Record<string,unknown>):Promise<PolicyAuthorization> {
  const activeProfile = gate.getActiveProfile();
  const config = activeProfile === gate.config.profile ? gate.config : { ...gate.config, profile: activeProfile };
  const cls=classifyTool(tool,args,gate.getProxyPermissions());
  if(session.revoked)throw new Error("POLICYGATE_SESSION_CLOSED: initialize a new session and reload context");
  if(session.locked) {
    if(store(gate).consumeUnlock(session.id)){session.locked=false;session.consecutiveDenials=0;}
    else throw new Error("POLICYGATE_SESSION_LOCKED: only operator CLI may unlock session "+session.id);
  }
  const payload=JSON.stringify(args);
  if(Buffer.byteLength(payload,"utf8")>config.limits.max_payload_bytes)
    return deny(session,gate,"POLICYGATE_PAYLOAD_LIMIT: reduce the tool arguments.");
  if(cls.kind!=="R"){
    const current=await gate.contextHash().catch(()=>"");
    if(config.context_files.length > 0 && (!session.contextHash || session.contextHash!==current)) {
      if(session.contextHash)await gate.invalidateContext(session,"source_changed_or_unavailable");
      await gate.audit.append({phase:"context_authorization",status:"denied",session_id:session.id,mcp_session_id:session.transportSessionId,reason:"context_required"});
      return deny(session,gate,"POLICYGATE_CONTEXT_REQUIRED: call system_context with agents and current_state in this session, then retry. Retain the same Mcp-Session-Id; a new or recovered session needs its own context load.",true);
    }
  }
  let approval=cls.requiresProxyApproval;
  const reasons:string[]=[];
  // Commands without working_directory use the persisted shell cwd, not
  // WORKSPACE_PATH. Analyze the same effective cwd the runner will execute in.
  const cwd=String(getShellStatus().cwd || process.env.WORKSPACE_PATH?.split(";")[0] || process.cwd());
  try {
    for(const target of pathsFromArgs(tool,args,cwd)) {
      const checked=checkPath(target.path,target.kind,config,gate.configPath,cwd);
      if(checked.approval && target.kind!=="R"){approval=true;reasons.push("approval_path: "+checked.resolved);}
      // Editing a chezmoi-managed target redirects to its canonical source.
      // Authorize that real write destination BEFORE the handler executes.
      if(config.context_files.length > 0 && target.kind==="W" && REDIRECTABLE_EDIT_TOOLS.has(tool)) {
        const inspection=await inspectChezmoiPath(checked.resolved);
        if(inspection.kind==="unavailable")
          throw new Error("POLICYGATE_CHEZMOI_UNAVAILABLE: "+inspection.explanation);
        if(inspection.kind==="generated_target")
          throw new Error("POLICYGATE_CHEZMOI_GENERATED_TARGET: "+checked.resolved+"; use the owning generator.");
        if(inspection.kind==="managed_target") {
          if(!inspection.sourcePath) throw new Error("POLICYGATE_CHEZMOI_SOURCE_MISSING: cannot authorize the redirected edit.");
          const source=checkPath(inspection.sourcePath,"W",config,gate.configPath);
          if(source.approval){approval=true;reasons.push("chezmoi source requires approval: "+source.resolved);}
        }
      }
    }
    if(["glob","grep","search_files","directory_tree"].includes(tool)) {
      const query=String(args.glob??args.pattern??"");
      if(config.sensitive_segments.some(x=>query.includes(x)) ||
        config.secret_names.some(x=>!x.includes("*") && query.includes(x)))
        return deny(session,gate,"POLICYGATE_SECRET_DENIED: search pattern targets a secret.");
    }
    if(tool==="apply_patch" && /\*\*\* (?:Add|Update|Delete) File:/m.test(String(args.patch??"")) &&
      pathsFromArgs(tool,args,cwd).length===0)
      return deny(session,gate,"POLICYGATE_PATCH_PATHS_UNRESOLVED: specify the target paths.");
    if(tool==="rewind" && args.action==="restore"){
      const { previewRestore }=await import("./checkpoint.js");
      const preview=await previewRestore(String(args.checkpoint_id??""));
      for(const item of preview.changes){
        const p=(item as {path?:string}).path;
        if(!p) return deny(session,gate,"POLICYGATE_REWIND_UNKNOWN_PATH: cannot restore checkpoint.");
        const checked=checkPath(p,"W",config,gate.configPath);
        if(checked.approval){approval=true;reasons.push("rewind target "+checked.resolved);}
      }
    }
    if(["run_command","start_process","system_job"].includes(tool) && (tool!=="system_job" || args.action==="start")){
      const command=String(args.command??"");
      const analysis=analyzeCommand(command,config,gate.configPath,String(args.working_directory??cwd));
      if(analysis.deny)return deny(session,gate,"POLICYGATE_COMMAND_DENIED: "+analysis.deny+"; use safe tools or request operator review.");
      if(analysis.approval){approval=true;reasons.push(...analysis.reasons);}
      if(config.profile==="strict" && /\b(?:sudo|doas|su|pkexec)\b/.test(command))
        return deny(session,gate,"POLICYGATE_STRICT_NO_SUDO: privileged commands are disabled.");
      if(config.profile==="strict" &&
        !config.allowed_commands.some(x=>command.trim()===x || command.trim().startsWith(x+" ")))
        return deny(session,gate,"POLICYGATE_STRICT_COMMAND_NOT_ALLOWED: ask the operator to allowlist this exact command.");
    }
    if(tool==="node_repl"){
      approval=true;reasons.push("arbitrary JavaScript evaluation");
      const code=String(args.code??"");
      if(/(?:localhost|127\.0\.0\.1|\[::1\]):3001|\/api\/(?:config\/env|local-tools|upstream)/.test(code))
        return deny(session,gate,"POLICYGATE_ADMIN_API_DENIED: the operator API is not accessible from MCP tools.");
      for(const p of [gate.configPath,config.audit_log,...config.hard_paths,...config.secret_paths,...config.protected_paths]){
        if(code.includes(p))return deny(session,gate,"POLICYGATE_INLINE_PROTECTED_PATH: "+p);
      }
    }
    if(tool==="ponytail_turn"){approval=true;reasons.push("trusted hook may spawn an executable");}
    if(tool==="mcp_test"){approval=true;reasons.push("operator-approved provider test");}
    if(tool==="mcp_call"){approval=true;reasons.push("arbitrary upstream MCP action");}
    if(tool==="mcp_servers" && args.refresh===true){approval=true;reasons.push("upstream process/reconfiguration");}
    if(tool==="rewind" && args.action==="clear"){approval=true;reasons.push("delete all saved rewind checkpoints");}
    if(tool==="clear_processes"){approval=true;reasons.push("stop all tracked processes");}
    if(["git_push","git_pull","git_reset","git_checkout","git_commit","git_restore"].includes(tool)){
      approval=true;reasons.push("Git operation may change files or run hooks");
    }
    if(tool==="git_commit" && args.stage_all!==false)reasons.push("bulk stage_all is enabled by default");
    if(tool==="git_add" && args.all!==false && !Array.isArray(args.files)){
      approval=true;reasons.push("bulk Git staging");
    }
    if(["edit_file","multi_edit","write_file","write_file_base64","apply_patch","replace_regex","copy_file","move_file"].includes(tool)){
      const filename=postEditHooksConfigPath();
      try {
        const hooks=JSON.parse(fs.readFileSync(filename,"utf8")) as {enabled?:boolean;hooks?:unknown[]};
        if(hooks.enabled && hooks.hooks?.length){approval=true;reasons.push("post-edit executable hook");}
      } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")return deny(session,gate,"POLICYGATE_POST_EDIT_HOOK_UNVERIFIED: operator must inspect hooks file.");}
    }
    if(cls.kind!=="R"){
      if(config.profile==="strict"){approval=true;reasons.push("strict mode requires signed operator approval for mutations");}
      session.mutationTimestamps=session.mutationTimestamps.filter(t=>t>Date.now()-60000);
      if(session.mutationTimestamps.length>=config.limits.max_mutations_per_minute)
        return deny(session,gate,"POLICYGATE_RATE_LIMIT: wait until earlier mutations leave the one-minute window.");
    }
    // Dangerous mode skips discretionary approvals and command allowlists but never explicit path/hard-path checks.
    if(config.profile==="dangerous")approval=false;
    if(approval){
      const request=store(gate).request(session.id,tool,args,
        tool+": "+(typeof args.command==="string"?args.command:JSON.stringify(args)),
        config.limits.approval_timeout_ms);
      if(!store(gate).consume(request))
        return deny(session,gate,"POLICYGATE_APPROVAL_REQUIRED: ask the operator to review the actual action and approve "+
          request.id+" using the out-of-band policygate-operator CLI; repeat the identical call afterward.");
    }
    if(cls.kind!=="R")session.mutationTimestamps.push(Date.now());
    session.consecutiveDenials=0;
    return {tool,kind:cls.kind,requiresApproval:approval};
  } catch(error){
    if(error instanceof Error && error.message.startsWith("POLICYGATE_") &&
      !error.message.includes("POLICYGATE_SESSION_LOCKED") &&
      !["POLICYGATE_APPROVAL_REQUIRED:","POLICYGATE_COMMAND_DENIED:","POLICYGATE_RATE_LIMIT:",
        "POLICYGATE_SECRET_DENIED: search","POLICYGATE_INLINE_PROTECTED_PATH:","POLICYGATE_ADMIN_API_DENIED:",
        "POLICYGATE_PATCH_PATHS_UNRESOLVED:","POLICYGATE_REWIND_UNKNOWN_PATH:",
        "POLICYGATE_STRICT_COMMAND_NOT_ALLOWED:","POLICYGATE_STRICT_NO_SUDO:","POLICYGATE_POST_EDIT_HOOK_UNVERIFIED:"]
        .some(x=>error.message.startsWith(x))){
      session.consecutiveDenials++;
      if(session.consecutiveDenials>=config.limits.max_denials)session.locked=true;
    }
    throw error;
  }
}
