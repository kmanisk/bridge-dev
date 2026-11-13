import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {parseUpstreamConfig,loadUpstreamConfigDetails} from "./mcp-upstream-config.js";
import {withFileLock} from "./atomic-store.js";

export interface RegistryMigration {
  path:string; source_schema:string; changed:boolean; dry_run:boolean;
  diff:{op:"add"|"replace";path:string;value:unknown}[];
  backup?:string; backup_sha256?:string;
}
const hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
export async function verifyRegistryBackup(filename:string,expected:Buffer):Promise<string>{
  const bytes=await fs.readFile(filename);
  if(!bytes.equals(expected))throw new Error("UPSTREAM_MIGRATION_BACKUP_VERIFICATION_FAILED: original remains unchanged");
  return hash(bytes);
}
/** Explicit operator-only file operation; never invoked by a loader or MCP tool. */
export async function migrateUpstreamConfig(filename:string,dryRun=false):Promise<RegistryMigration>{
  filename=path.resolve(filename);
  const inspect=async()=>{
    const loaded=await loadUpstreamConfigDetails(filename);
    if(loaded.source_schema==="missing")throw new Error("UPSTREAM_MIGRATION_MISSING: select an existing registry");
    const original=await fs.readFile(filename),checked=parseUpstreamConfig(original.toString("utf8"));
    const diff:RegistryMigration["diff"]=[];
    if(checked.migration_required){
      diff.push({op:"add",path:"/version",value:1});
      const old=JSON.parse(original.toString("utf8"));
      checked.document.servers.forEach((server,index)=>{
        for(const key of ["enabled","expose"] as const)if(old.servers[index][key]!==server[key])diff.push({op:Object.hasOwn(old.servers[index],key)?"replace":"add",path:`/servers/${index}/${key}`,value:server[key]});
      });
    }
    return {original,checked,result:{path:filename,source_schema:checked.source_schema,changed:checked.migration_required,dry_run:dryRun,diff} as RegistryMigration};
  };
  const preview=await inspect();
  if(dryRun||!preview.result.changed)return preview.result;
  try{return await withFileLock(filename,async()=>{
    const {original,checked,result}=await inspect();if(!result.changed)return result;
    const stat=await fs.lstat(filename),parent=await fs.stat(path.dirname(filename));
    if(process.platform!=="win32"&&(!(stat.mode&0o222)||!(parent.mode&0o222)))throw new Error("READ_ONLY: registry or directory has no write permission");
    const stamp=new Date().toISOString().replace(/[:.]/g,"-");
    const backup=filename+".backup-"+stamp+"-"+randomUUID().slice(0,8),temp=filename+"."+randomUUID()+".migration.tmp";
    let handle=await fs.open(backup,"wx",0o600);
    try{await handle.writeFile(original);await handle.sync();}finally{await handle.close();}
    const backupHash=await verifyRegistryBackup(backup,original);
    try{
      handle=await fs.open(temp,"wx",0o600);
      try{
        await handle.writeFile(JSON.stringify(checked.document,null,2)+"\n");
        if(process.platform!=="win32"){
          const owner=await handle.stat();if(owner.uid!==stat.uid||owner.gid!==stat.gid)await handle.chown(stat.uid,stat.gid);
          await handle.chmod(stat.mode&0o777);
        }
        await handle.sync();
      }finally{await handle.close();}
      const current=await fs.lstat(filename);
      if(current.isSymbolicLink()||current.dev!==stat.dev||current.ino!==stat.ino||!(await fs.readFile(filename)).equals(original))throw new Error("REGISTRY_CHANGED: regenerate the dry-run");
      await fs.rename(temp,filename);
      return {...result,backup,backup_sha256:backupHash};
    }finally{await fs.rm(temp,{force:true});}
  });}catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code&&["EACCES","EPERM","EROFS"].includes(code))throw new Error("UPSTREAM_MIGRATION_BLOCKED: "+code+"; use an authorized operator on a writable registry directory");
    throw error;
  }
}
