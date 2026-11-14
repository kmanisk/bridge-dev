import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { requestIdentity } from "./request-identity.js";
import {hostControllerAvailable} from "./host-controller.js";
import {readLeaseActivation,verifyLeaseActivation,isActiveLease} from "../../scripts/lease-activation.mjs";
import { fileURLToPath } from "node:url";
import { assertRegistryComplete, classifyTool, type ToolClass } from "./tool-classification.js";
import { enforcePolicy } from "./policy-enforcement.js";
import { HashAudit } from "./hash-audit.js";
import { getRuntimeMode, makePortablePolicy, portableStateDir } from "./runtime.js";
import type { SystemDocument } from "./system-context.js";

export interface PolicyLimits {
  max_payload_bytes: number;
  max_mutations_per_minute: number;
  max_denials: number;
  approval_timeout_ms: number;
}
export interface PolicyConfig {
  profile: "strict" | "standard" | "dangerous";
  dangerous_enabled: boolean;
  context_files: string[];
  writable_roots: string[];
  protected_paths: string[];
  secret_paths: string[];
  secret_names: string[];
  approval_paths: string[];
  sensitive_segments: string[];
  hard_paths: string[];
  allowed_commands: string[];
  approval_commands: string[];
  denied_commands: string[];
  proxy_tools: Record<string, ToolClass>;
  limits: PolicyLimits;
  audit_log: string;
}
export interface PolicySession {
  id: string;
  transportSessionId?: string;
  revoked?: boolean;
  expiresAt?: number;
  contextHash: string | null;
  mutationTimestamps: number[];
  consecutiveDenials: number;
  locked: boolean;
}
export interface PolicyAuthorization {
  hostRoot?: boolean;
  rootApprovalId?: string;
  kind: ToolClass;
  tool: string;
  requiresApproval: boolean;
}
const policyExamplePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../profiles/policy.example.json");
const configKeys = [
  "profile", "dangerous_enabled", "context_files", "writable_roots", "protected_paths",
  "secret_paths", "secret_names", "approval_paths", "sensitive_segments", "hard_paths",
  "allowed_commands", "approval_commands", "denied_commands", "proxy_tools", "limits", "audit_log",
] as const;
const limitKeys = ["max_payload_bytes","max_mutations_per_minute","max_denials","approval_timeout_ms"];

export function newPolicySession(): PolicySession {
  return { id: randomUUID(), contextHash: null, mutationTimestamps: [], consecutiveDenials: 0, locked: false };
}
function expandPath(raw: string): string {
  return path.resolve(raw.replace(/^\$HOME(?=\/|$)/, os.homedir()).replace(/^~(?=\/|$)/, os.homedir()));
}
function validateConfig(source: unknown): PolicyConfig {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("POLICYGATE_CONFIG_INVALID: expected object");
  const raw = source as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!(configKeys as readonly string[]).includes(key))
    throw new Error("POLICYGATE_CONFIG_UNKNOWN_KEY: " + key);
  for (const required of configKeys) if (!(required in raw)) throw new Error("POLICYGATE_CONFIG_MISSING_KEY: " + required);
  if (!["strict","standard","dangerous"].includes(String(raw.profile)) || typeof raw.dangerous_enabled !== "boolean")
    throw new Error("POLICYGATE_CONFIG_INVALID: profile/dangerous_enabled");
  const arrayKeys = ["context_files","writable_roots","protected_paths","secret_paths","secret_names",
    "approval_paths","sensitive_segments","hard_paths","allowed_commands","approval_commands","denied_commands"];
  for (const key of arrayKeys)
    if (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every((v) => typeof v === "string" && v.length > 0))
      throw new Error("POLICYGATE_CONFIG_INVALID: " + key);
  if (typeof raw.audit_log !== "string" || !raw.audit_log) throw new Error("POLICYGATE_CONFIG_INVALID: audit_log");
  if (!raw.limits || typeof raw.limits !== "object" || Array.isArray(raw.limits))
    throw new Error("POLICYGATE_CONFIG_INVALID: limits");
  const limits = raw.limits as Record<string, unknown>;
  for (const key of Object.keys(limits)) if (!limitKeys.includes(key)) throw new Error("POLICYGATE_CONFIG_UNKNOWN_LIMIT: " + key);
  for (const key of limitKeys) if (!Number.isSafeInteger(limits[key]) || Number(limits[key]) <= 0)
    throw new Error("POLICYGATE_CONFIG_INVALID_LIMIT: " + key);
  if (!raw.proxy_tools || typeof raw.proxy_tools !== "object" || Array.isArray(raw.proxy_tools))
    throw new Error("POLICYGATE_CONFIG_INVALID: proxy_tools");
  for (const [name, value] of Object.entries(raw.proxy_tools)) {
    if (!/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(name) || !["R","W","X"].includes(String(value)))
      throw new Error("POLICYGATE_CONFIG_INVALID_PROXY: " + name);
  }
  const cfg = raw as unknown as PolicyConfig;
  if (cfg.context_files.length !== 2) throw new Error("POLICYGATE_CONFIG_INVALID: exactly two canonical context files required");
  for (const key of ["context_files","writable_roots","protected_paths","secret_paths","approval_paths","hard_paths"] as const)
    cfg[key] = cfg[key].map(expandPath);
  cfg.audit_log = expandPath(cfg.audit_log);
  if (cfg.profile === "dangerous" && (!cfg.dangerous_enabled || process.env.POLICYGATE_DANGEROUS !== "yes"))
    throw new Error("POLICYGATE_DANGEROUS_UNAUTHORIZED: operator must set POLICYGATE_DANGEROUS=yes and dangerous_enabled=true");
  return cfg;
}
export function loadPolicyConfig(file = process.env.POLICYGATE_POLICY_FILE || policyExamplePath): PolicyConfig {
  const filePath = expandPath(file);
  const config = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return validateConfig(config);
}
export class PolicyGate {
  private readonly contextKey = randomBytes(32);
  private readonly contextIssuers = new Map<string, {session:PolicySession; subject:string; expires:number}>();
  readonly config: PolicyConfig;
  readonly configPath: string;
  private nativeRegistrations = new Set<string>();
  readonly audit: HashAudit;
  private providerPermissions:Record<string,ToolClass>={};
  setProviderPermissions(value:Record<string,ToolClass>):void{this.providerPermissions=value;}
  getProxyPermissions():Record<string,ToolClass>{return getRuntimeMode()==="portable"?{...this.providerPermissions,...this.config.proxy_tools}:this.config.proxy_tools;}
  constructor(file?: string) {
    if (!file && getRuntimeMode() === "portable") {
      this.configPath = path.join(portableStateDir(), "portable-policy.json");
      this.config = makePortablePolicy();
    } else {
      this.configPath = expandPath(file || process.env.POLICYGATE_POLICY_FILE || policyExamplePath);
      this.config = loadPolicyConfig(this.configPath);
    }
    this.audit = new HashAudit(this.config.audit_log);
  }
  register(name: string): void {
    // A proxy name without an explicit classification is X/approval, never implicit read.
    classifyTool(name, {}, this.config.proxy_tools);
    if (!name.includes("__")) this.nativeRegistrations.add(name);
  }
  assertComplete(includeBridge = true): void { assertRegistryComplete(this.nativeRegistrations, includeBridge); }
  async contextHash(): Promise<string> {
    const digester = createHash("sha256");
    for (const filename of this.config.context_files) {
      const content = await fsp.readFile(filename);
      digester.update(filename).update("\0").update(createHash("sha256").update(content).digest("hex")).update("\0");
    }
    return digester.digest("hex");
  }
  getActiveProfile(): "strict" | "standard" | "dangerous" {
    if (this.config.context_files.length === 0) {
      try{const mode=JSON.parse(fs.readFileSync(path.join(portableStateDir(),"mode.json"),"utf8"));if(mode.mode==="strict")return "strict";}catch{}
      return "standard";
    } // portable cannot activate a privileged operator lease
    const controllerAvailable=hostControllerAvailable();
    const activationFile=process.env.POLICYGATE_YOLO_ACTIVATION_FILE || (controllerAvailable?"/var/lib/bridge-dev-operator/active-lease.json":undefined);
    const yoloPath = process.env.POLICYGATE_YOLO_LEASE || (fs.existsSync("/var/lib/bridge-dev/yolo-lease.json") ? "/var/lib/bridge-dev/yolo-lease.json" : "/var/lib/local-coder-policygate/yolo-lease.json");
    const pubKeyPath = process.env.POLICYGATE_APPROVAL_PUBLIC_KEY || (fs.existsSync("/etc/bridge-dev/operator-public.pem") ? "/etc/bridge-dev/operator-public.pem" : "/etc/local-coder-policygate/operator-public.pem");
    try {
      if (fs.existsSync(yoloPath) && fs.existsSync(pubKeyPath)) {
        const content = fs.readFileSync(yoloPath, "utf8");
        const lease = JSON.parse(content) as {
          mode: string;
          expires_at: number | null;
          signature: string;
          nonce?: string;
          scope?: string;
          lifetime?: string;
        };
        if (isActiveLease(lease)) {
          const msg = JSON.stringify({ mode: lease.mode, expires_at: lease.expires_at, ...(lease.nonce ? { nonce: lease.nonce } : {}),...(lease.scope?{scope:lease.scope}:{}),...(lease.lifetime?{lifetime:lease.lifetime}:{}) });
          const pubKey = fs.readFileSync(pubKeyPath, "utf8");
          const ok = verify(null, Buffer.from(msg), pubKey, Buffer.from(lease.signature, "base64"));
          if (ok && controllerAvailable && activationFile && verifyLeaseActivation(activationFile,lease,this.configPath)) return "dangerous";
        }
      }
    } catch {
      // Ignore lease parse or verification error, fall back to configured/override profile
    }

    // Installed controllers publish protected mode state. Never fall back to
    // the legacy service-writable override after a revocation or corrupt marker.
    if(activationFile)return readLeaseActivation(activationFile,this.configPath)?.mode||"strict";
    const modeOverridePath = process.env.POLICYGATE_MODE_FILE || (fs.existsSync("/var/lib/bridge-dev/mode.json") ? "/var/lib/bridge-dev/mode.json" : "/var/lib/local-coder-policygate/mode.json");
    try {
      if (fs.existsSync(modeOverridePath)) {
        const raw = JSON.parse(fs.readFileSync(modeOverridePath, "utf8")) as { mode?: string };
        if (raw.mode === "strict" || raw.mode === "standard") {
          return raw.mode;
        }
      }
    } catch {
      // Ignore
    }

    return this.config.profile;
  }
  async invalidateContext(session: PolicySession, reason: string, revoke = false): Promise<void> {
    session.contextHash = null;
    if (revoke) session.revoked = true;
    this.contextIssuers.delete(session.id);
    await this.audit.append({phase:"context_authorization",status:"invalidated",session_id:session.id,mcp_session_id:session.transportSessionId,reason});
  }
  issueContextToken(session:PolicySession): {context_token:string; context_expires_at:number} | undefined {
    const subject=requestIdentity.getStore()?.subject;
    if(!subject || !session.contextHash || session.revoked)return;
    const now=Date.now();
    for(const [id,entry] of this.contextIssuers)if(entry.expires<=now || entry.session.revoked)this.contextIssuers.delete(id);
    if(this.contextIssuers.size>=10000)throw new Error("POLICYGATE_CONTEXT_CAPACITY: retry after existing grants expire");
    const expires=Math.min(now+5*60_000,session.expiresAt??Infinity);
    const payload=Buffer.from(JSON.stringify({v:1,issuer:session.id,subject,hash:session.contextHash,expires})).toString("base64url");
    const signature=createHmac("sha256",this.contextKey).update(payload).digest("base64url");
    this.contextIssuers.set(session.id,{session,subject,expires});
    return {context_token:payload+"."+signature,context_expires_at:expires};
  }
  async acceptContextToken(session:PolicySession,value:unknown):Promise<boolean> {
    if(typeof value!=="string" || value.length>2048 || session.revoked)return false;
    const [payload,signature,...extra]=value.split(".");
    if(!payload || !signature || extra.length)return false;
    const expected=createHmac("sha256",this.contextKey).update(payload).digest();
    const supplied=Buffer.from(signature,"base64url");
    if(supplied.length!==expected.length || !timingSafeEqual(expected,supplied))return false;
    let token;try{token=JSON.parse(Buffer.from(payload,"base64url").toString());}catch{return false;}
    const issuer=this.contextIssuers.get(token.issuer),subject=requestIdentity.getStore()?.subject,now=Date.now();
    if(!issuer || !subject || subject!==token.subject || subject!==issuer.subject || token.v!==1 ||
      token.expires!==issuer.expires || token.expires<=now || issuer.session.revoked ||
      (issuer.session.expiresAt??Infinity)<=now || issuer.session.contextHash!==token.hash)return false;
    const current=await this.contextHash().catch(()=>"");
    if(current!==token.hash){await this.invalidateContext(issuer.session,"capability_context_changed");return false;}
    // Request-scoped proof: do not grant the recipient transport session authority.
    await this.audit.append({phase:"context_authorization",status:"granted",session_id:session.id,issuer_session_id:issuer.session.id,reason:"explicit_context_token"});
    return true;
  }
  async contextLoaded(session: PolicySession, args: Record<string, unknown>, data: {documents?: SystemDocument[]; configured?: boolean}): Promise<void> {
    if (session.revoked) throw new Error("POLICYGATE_SESSION_CLOSED: initialize a new session and reload context");
    if (!this.config.context_files.length) return;
    const docs = args.docs;
    if (Array.isArray(docs) && !(docs.includes("agents") && docs.includes("current_state"))) return;
    // Bind authorization to the actual bytes returned by the native loader,
    // including truncated documents' full-file digests, never a later reread.
    const digest = createHash("sha256");
    for (const filename of this.config.context_files) {
      const document = data.documents?.find(d => ["agents","current_state"].includes(d.kind) && path.resolve(d.path) === path.resolve(filename));
      if (data.configured === false || !document || document.error || !/^[a-f0-9]{64}$/.test(document.sha256 || "")) {
        await this.invalidateContext(session,"required_document_unavailable");
        throw new Error("POLICYGATE_CONTEXT_UNAVAILABLE: required policy documents were not loaded");
      }
      digest.update(filename).update("\0").update(document.sha256!).update("\0");
    }
    const loaded = digest.digest("hex");
    if (loaded !== await this.contextHash()) {
      await this.invalidateContext(session,"changed_during_load");
      throw new Error("POLICYGATE_CONTEXT_REQUIRED: context changed while loading; reload in this session");
    }
    await this.audit.append({phase:"context_authorization",status:"granted",session_id:session.id,mcp_session_id:session.transportSessionId});
    session.contextHash = loaded;
    session.consecutiveDenials = 0;
  }
  async authorize(session: PolicySession, tool: string, args: Record<string, unknown>,contextToken:unknown=args.context_token): Promise<PolicyAuthorization> {
    return enforcePolicy(this, session, tool, args,contextToken);
  }
}
let singleton: PolicyGate | undefined;
export function getPolicyGate(): PolicyGate {
  singleton ??= new PolicyGate();
  return singleton;
}
