import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const ZERO_HASH = "0".repeat(64);
export interface ChainVerification { entries: number; last_hash: string; bytes: number; }
function digest(record: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
export function redactAudit(value: unknown, key = ""): unknown {
  if (/(token|password|authorization|bearer|credential|private_key|api_key|secret|cookie|^(?:content|patch|code|replacement|note)$)/i.test(key))
    return "[REDACTED]";
  if(typeof value === "string") return value
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi,"$1[REDACTED]")
    .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi,"$1[REDACTED]")
    .replace(/(\/(?:mcp\/)?)[A-Za-z0-9_-]{30,}(?=\/|\s|$)/g,"$1[REDACTED]")
    .replace(/(\b(?:MCP_TOKEN|ADMIN_TOKEN|PASSWORD|API_KEY)=)[^\s]+/gi,"$1[REDACTED]")
    .replace(/(--(?:password|token|api-key|secret)(?:=|\s+))[^\s]+/gi,"$1[REDACTED]")
    .replace(/(\b(?:password|token|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi,"$1[REDACTED]");
  if (Array.isArray(value)) return value.map((x)=>redactAudit(x,key));
  if (value && typeof value === "object") {
    const output: Record<string,unknown> = {};
    for(const [k,v] of Object.entries(value)) output[k]=redactAudit(v,k);
    return output;
  }
  return value;
}
export function verifyAuditFile(filename: string): ChainVerification {
  let stat: fs.Stats;
  try { stat=fs.lstatSync(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {entries:0,last_hash:ZERO_HASH,bytes:0};
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("POLICYGATE_AUDIT_UNSAFE_PATH: ledger must be a regular file, not a symlink");
  const bytes=fs.readFileSync(filename);
  if(bytes.length && bytes[bytes.length-1]!==10)throw new Error("POLICYGATE_AUDIT_TRUNCATED: ledger must end in newline");
  const lines=bytes.toString("utf8").split("\n");
  let last=ZERO_HASH,count=0;
  for(const line of lines){
    if(!line)continue;
    let record:Record<string,unknown>;
    try{record=JSON.parse(line);}catch{throw new Error("POLICYGATE_AUDIT_MALFORMED at entry "+(count+1));}
    if(record.prev_hash!==last)throw new Error("POLICYGATE_AUDIT_CHAIN_BROKEN at entry "+(count+1));
    const {hash,...body}=record;
    if(typeof hash!=="string" || !/^[a-f0-9]{64}$/.test(hash) || digest(body)!==hash)
      throw new Error("POLICYGATE_AUDIT_HASH_MISMATCH at entry "+(count+1));
    last=hash;count++;
  }
  return {entries:count,last_hash:last,bytes:bytes.length};
}
export class HashAudit {
  readonly filename:string;
  private last:string;
  private bytes:number;
  private device: number | null = null;
  private inode: number | null = null;
  private queue:Promise<void>=Promise.resolve();
  private broken=false;
  constructor(filename:string){
    this.filename=path.resolve(filename);
    const verified=verifyAuditFile(this.filename);
    this.last=verified.last_hash;this.bytes=verified.bytes;
    try {
      const st=fs.lstatSync(this.filename);
      this.device=st.dev;this.inode=st.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  append(event:Record<string,unknown>):Promise<void> {
    const operation = async()=>{
      if(this.broken)throw new Error("POLICYGATE_AUDIT_LOCKED: previous append or verification failed");
      try {
        await fsp.mkdir(path.dirname(this.filename),{recursive:true,mode:0o700});
        const stat=await fsp.lstat(this.filename).catch((e:NodeJS.ErrnoException)=>{
          if(e.code==="ENOENT")return null;throw e;
        });
        if(stat && (!stat.isFile() || stat.isSymbolicLink() ||
          (this.device!==null && (stat.dev!==this.device || stat.ino!==this.inode)))) {
          throw new Error("POLICYGATE_AUDIT_CHANGED_DURING_RUNTIME: audit inode replaced or path became unsafe; stop server");
        }
        if(!stat && this.device!==null)throw new Error("POLICYGATE_AUDIT_CHANGED_DURING_RUNTIME: ledger disappeared");
        if((stat?.size||0)!==this.bytes)throw new Error("POLICYGATE_AUDIT_CHANGED_DURING_RUNTIME: file size changed; stop server");
        const safe=redactAudit(event) as Record<string,unknown>;
        const body={v:1,time:new Date().toISOString(),...safe,prev_hash:this.last};
        const hash=digest(body);
        const encoded=JSON.stringify({...body,hash})+"\n";
        const handle=await fsp.open(this.filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
        try {
          const current=await handle.stat();
          if((this.device!==null && (current.dev!==this.device || current.ino!==this.inode)) || !current.isFile())
            throw new Error("POLICYGATE_AUDIT_CHANGED_DURING_RUNTIME: different inode at open");
          if(current.size!==this.bytes)
            throw new Error("POLICYGATE_AUDIT_CHANGED_DURING_RUNTIME: different ledger size at open");
          await handle.writeFile(encoded,"utf8");
          await handle.sync();
          this.device=current.dev;this.inode=current.ino;
        } finally {await handle.close();}
        this.last=hash;
        this.bytes+=Buffer.byteLength(encoded);
      }catch(error){this.broken=true;throw new Error("POLICYGATE_AUDIT_WRITE_FAILED: action refused; "+String(error));}
    };
    const task=this.queue.then(operation);
    this.queue=task.catch(()=>{});
    return task;
  }
}
