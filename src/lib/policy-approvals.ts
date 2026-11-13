import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, createPublicKey, verify } from "node:crypto";

export interface ApprovalRequest {
  id: string;
  fingerprint: string;
  session_id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  created_at: number;
  expires_at: number;
}
export interface ApprovalTicket {
  id: string;
  fingerprint: string;
  session_id: string;
  expires_at: number;
  signature: string;
}
export function approvalDirectory(auditPath: string): string {
  return path.resolve(process.env.POLICYGATE_APPROVAL_DIR || path.join(path.dirname(auditPath),"policy-approvals"));
}
export function requestFingerprint(sessionId: string, tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ sessionId, tool, args })).digest("hex");
}
export function approvalId(fingerprint: string): string { return fingerprint.slice(0, 24); }
export function approvalPayload(req: Pick<ApprovalRequest, "id" | "fingerprint" | "session_id" | "expires_at">): string {
  return JSON.stringify({id:req.id,fingerprint:req.fingerprint,session_id:req.session_id,expires_at:req.expires_at});
}
export class ApprovalStore {
  readonly directory: string;
  private publicKey: ReturnType<typeof createPublicKey> | null;
  private consumed = new Set<string>();
  constructor(auditPath: string) {
    this.directory = approvalDirectory(auditPath);
    const filename = process.env.POLICYGATE_APPROVAL_PUBLIC_KEY;
    this.publicKey = filename ? createPublicKey(fs.readFileSync(filename)) : null;
  }
  request(sessionId: string, tool: string, args: Record<string, unknown>, summary: string, ttlMs: number): ApprovalRequest {
    const fingerprint = requestFingerprint(sessionId,tool,args);
    const id = approvalId(fingerprint);
    const file = path.join(this.directory,id+".request.json");
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    if(fs.existsSync(file)) {
      const old = JSON.parse(fs.readFileSync(file,"utf8")) as ApprovalRequest;
      if(old.fingerprint === fingerprint && old.session_id === sessionId && Date.now() < old.expires_at) {
        if(old.summary !== summary || old.tool !== tool ||
          requestFingerprint(old.session_id,old.tool,old.args) !== fingerprint)
          throw new Error("POLICYGATE_APPROVAL_REQUEST_TAMPERED: request contents do not match the action fingerprint.");
        return old;
      }
    }
    const req: ApprovalRequest = {
      id,fingerprint,session_id:sessionId,tool,args,summary,created_at:Date.now(),expires_at:Date.now()+ttlMs,
    };
    fs.writeFileSync(file,JSON.stringify(req,null,2)+"\n",{mode:0o600});
    return req;
  }
  consume(req: ApprovalRequest): boolean {
    if(!this.publicKey || this.consumed.has(req.id) ||
      requestFingerprint(req.session_id,req.tool,req.args) !== req.fingerprint) return false;
    try {
      const saved=JSON.parse(fs.readFileSync(path.join(this.directory,req.id+".request.json"),"utf8")) as ApprovalRequest;
      if(saved.summary!==req.summary || saved.fingerprint!==req.fingerprint ||
        saved.session_id!==req.session_id || saved.expires_at!==req.expires_at ||
        saved.tool!==req.tool || requestFingerprint(saved.session_id,saved.tool,saved.args)!==req.fingerprint) return false;
    }catch{return false;}
    const filename=path.join(this.directory,req.id+".approved.json");
    let ticket: ApprovalTicket;
    try {ticket=JSON.parse(fs.readFileSync(filename,"utf8")) as ApprovalTicket;}catch{return false;}
    if(ticket.id!==req.id || ticket.fingerprint!==req.fingerprint ||
      ticket.session_id!==req.session_id || ticket.expires_at!==req.expires_at || Date.now()>ticket.expires_at) return false;
    const ok=verify(null,Buffer.from(approvalPayload(ticket)),this.publicKey,Buffer.from(ticket.signature,"base64"));
    if(!ok)return false;
    try {fs.renameSync(filename,path.join(this.directory,req.id+".used"));}catch{return false;}
    this.consumed.add(req.id);
    return true;
  }
  consumeUnlock(sessionId:string):boolean {
    if(!this.publicKey)return false;
    const name=path.join(this.directory,"unlock-"+sessionId+".json");
    let ticket: { session_id:string; expires_at:number; signature:string };
    try {ticket=JSON.parse(fs.readFileSync(name,"utf8"));}catch{return false;}
    const msg=JSON.stringify({session_id:ticket.session_id,expires_at:ticket.expires_at});
    if(ticket.session_id!==sessionId || Date.now()>ticket.expires_at ||
      !verify(null,Buffer.from(msg),this.publicKey,Buffer.from(ticket.signature,"base64")))return false;
    try {fs.renameSync(name,name+".used");}catch{return false;}
    return true;
  }
}
