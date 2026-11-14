import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verify } from "node:crypto";
import { verifyAuditFile } from "./hash-audit.js";
import {readLeaseActivation,verifyLeaseActivation,isActiveLease} from "../../scripts/lease-activation.mjs";

export type CliMode = "STRICT" | "STANDARD" | "YOLO" | "UNKNOWN";
export interface ModeReading { mode: CliMode; detail: string; }
export function formatMcpEndpoint(baseUrl: string, token = "", reveal = false): string {
  return baseUrl.replace(/\/+$/, "") + "/mcp/" + (reveal && token ? encodeURIComponent(token) : "<MCP_TOKEN>");
}
export function isValidSignedLease(lease: unknown, publicKeyPem: string | Buffer, now = Date.now()): boolean {
  if (!lease || typeof lease !== "object") return false;
  const x = lease as Record<string, unknown>;
  if (!(isActiveLease(x,now) ||
        (x.mode==="dangerous" && x.scope===undefined && x.lifetime===undefined &&
          Number.isSafeInteger(x.expires_at) && (x.expires_at as number)>now &&
          typeof x.nonce==="string" && x.nonce.length>0)) ||
      typeof x.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(x.signature) ||
      (x.scope!==undefined&&x.scope!=="host-root-v1") ||
      (x.nonce !== undefined && (typeof x.nonce !== "string" || !x.nonce.length))) return false;
  try {
    const message = JSON.stringify({mode:x.mode,expires_at:x.expires_at,...(x.nonce?{nonce:x.nonce}:{}),...(x.scope?{scope:x.scope}:{}),...(x.lifetime?{lifetime:x.lifetime}:{})});
    return verify(null,Buffer.from(message),publicKeyPem,Buffer.from(x.signature,"base64"));
  } catch { return false; }
}
export function inspectLocalMode(options: {
  stateDir: string; publicKeyFile: string; leaseFile?: string; modeFile?: string; activationFile?: string; now?: number;
}): ModeReading {
  const leaseFile = options.leaseFile || path.join(options.stateDir,"yolo-lease.json");
  const modeFile = options.modeFile || path.join(options.stateDir,"mode.json");
  try { fs.accessSync(options.stateDir,fs.constants.R_OK|fs.constants.X_OK); }
  catch { return {mode:"UNKNOWN",detail:"operator-only mode state; use operator status"}; }
  try {
    if (fs.existsSync(leaseFile)) {
      const lease = JSON.parse(fs.readFileSync(leaseFile,"utf8"));
      if (isActiveLease(lease, options.now ?? Date.now())) {
        if (!isValidSignedLease(lease,fs.readFileSync(options.publicKeyFile),options.now ?? Date.now())) {
          return {mode:"UNKNOWN",detail:"unverified signed lease; operator investigation required"};
        }
        if(options.activationFile&&verifyLeaseActivation(options.activationFile,lease,options.publicKeyFile)){
          const desc=lease.lifetime==="until_off"?"until manually disabled":
            Math.max(1,Math.ceil((lease.expires_at-(options.now??Date.now()))/60000))+" minute(s) remaining";
          return {mode:"YOLO",detail:"verified signed lease; "+desc};
        }
      }
    }
    if(options.activationFile){
      const active=readLeaseActivation(options.activationFile,options.publicKeyFile);
      return active?{mode:active.mode.toUpperCase() as CliMode,detail:"protected operator mode; no active host lease"}:{mode:"UNKNOWN",detail:"protected operator state unavailable"};
    }
    if (fs.existsSync(modeFile)) {
      const mode=JSON.parse(fs.readFileSync(modeFile,"utf8")).mode;
      if (mode==="strict") return {mode:"STRICT",detail:"operator-selected"};
      if (mode==="standard") return {mode:"STANDARD",detail:"operator-selected"};
      return {mode:"UNKNOWN",detail:"invalid operator mode"};
    }
  } catch { return {mode:"UNKNOWN",detail:"mode state or signing key unreadable"}; }
  return {mode:"UNKNOWN",detail:"no readable operator mode record"};
}
export function validateProjectName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name==="." || name==="..")
    throw new Error("Invalid project name: only a single safe directory name is allowed");
  return name;
}
export function resolveProjectDirectory(input: string, home=os.homedir()): string {
  if (!input || input.startsWith("-") || /[\x00-\x1f\x7f]/.test(input))
    throw new Error("Invalid project path");
  let target=path.resolve(input);
  if (!fs.existsSync(target) && !path.isAbsolute(input)) {
    const candidate=path.join(home,"Projects",input);
    if (fs.existsSync(candidate)) target=candidate;
  }
  const resolved=fs.realpathSync(target);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Project must be a directory");
  validateProjectName(path.basename(resolved));
  if (resolved===path.parse(resolved).root ||
      ["/home","/root","/etc","/var","/usr","/opt","/proc","/sys","/dev"].includes(resolved) ||
      /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.config|\.local\/share\/keyrings)(?:\/|$)/.test(resolved))
    throw new Error("Refusing to map system or credential directories");
  return resolved;
}
export function verifyAuditProof(ledger: string,anchorFile: string): {
  entries:number; anchoredEntries:number; lastHash:string;
} {
  const st=fs.lstatSync(ledger), anchorSt=fs.lstatSync(anchorFile);
  if (!st.isFile() || st.isSymbolicLink() || !anchorSt.isFile() || anchorSt.isSymbolicLink())
    throw new Error("Audit and anchor must be regular files");
  const chain=verifyAuditFile(ledger);
  const anchor=JSON.parse(fs.readFileSync(anchorFile,"utf8")) as {entries?:unknown;last_hash?:unknown};
  if (!Number.isSafeInteger(anchor.entries) || (anchor.entries as number)<0 ||
      (anchor.entries as number)>chain.entries || typeof anchor.last_hash!=="string" ||
      !/^[a-f0-9]{64}$/.test(anchor.last_hash)) throw new Error("Invalid trusted audit anchor");
  const count=anchor.entries as number;
  const actual=count===0?"0".repeat(64):JSON.parse(fs.readFileSync(ledger,"utf8").split("\n")[count-1]).hash;
  if (actual!==anchor.last_hash) throw new Error("Audit chain differs from trusted anchor");
  return {entries:chain.entries,anchoredEntries:count,lastHash:chain.last_hash};
}
