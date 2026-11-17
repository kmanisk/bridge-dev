import fs from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {verifyRelease} from "./service-release.js";
import {operatorEnvironment,sourceRoot} from "./service-config.js";

export interface ShadowReceipt {
  ok:true;
  checks:Record<string,boolean>;
  native:number;
  read_tools:number;
  production_secrets_inaccessible:true;
  production_network_isolated:true;
}
/** No live ports, credentials, leases, or host-system mounts are exposed.
 * The verification process itself runs inside bwrap's separate mount, user,
 * PID, IPC and network namespaces. bwrap is optional: unavailable means
 * NO UPDATE, not an unisolated retry. */
export function shadowBubblewrapArgs(
  release:string, scratch:string, node:string, productionPort:number
):string[]{
  for(const p of [release,scratch,node])if(!path.isAbsolute(p))throw Error("SHADOW_ABSOLUTE_PATH_REQUIRED");
  if(!Number.isSafeInteger(productionPort)||productionPort<=0||productionPort>65535)
    throw Error("SHADOW_PRODUCTION_PORT_INVALID");
  return [
    "--unshare-all","--die-with-parent","--new-session",
    "--ro-bind","/usr","/usr",
    "--tmpfs","/usr/local", // Never expose the independently installed root controller.
    "--symlink","usr/bin","/bin",
    "--symlink","usr/lib","/lib",
    "--symlink","usr/lib64","/lib64",
    "--dir","/opt",
    "--ro-bind",node,"/opt/shadow-node",
    "--ro-bind",release,"/release",
    // The acceptance implementation must come from the already trusted
    // operator runtime, NOT from the candidate release under test.
    // Only harness scripts and dependencies are mounted, never .env.
    "--dir","/harness",
    "--ro-bind",path.join(sourceRoot,"scripts"),"/harness/scripts",
    "--ro-bind",path.join(sourceRoot,"node_modules"),"/harness/node_modules",
    "--bind",scratch,"/shadow",
    "--dir","/home","--dir","/var","--dir","/etc",
    "--proc","/proc","--dev","/dev","--tmpfs","/tmp",
    "--chdir","/shadow",
    "--clearenv",
    "--setenv","PATH","/usr/bin:/bin",
    "--setenv","HOME","/shadow",
    "--setenv","BRIDGEDEV_SHADOW_HOST_HOME",process.env.HOME||"/nonexistent-host-home",
    "--setenv","BRIDGEDEV_SHADOW_SANDBOX","v1",
    "--setenv","BRIDGEDEV_SHADOW_PRODUCTION_PORT",String(productionPort),
    "--","/opt/shadow-node","/harness/scripts/shadow-release-acceptance.mjs",
  ];
}
export async function runShadowAcceptance(
  release:string,jobDirectory:string,productionPort:number,node=process.execPath
):Promise<ShadowReceipt>{
  await verifyRelease(release);
  if(process.platform!=="linux")throw Error("UPDATE_SHADOW_LINUX_ONLY");
  const scratch=await fs.mkdtemp(path.join(jobDirectory,".shadow-"));
  let child:ReturnType<typeof spawn>|undefined;
  try{
    const binary=await fs.realpath(node);
    const args=shadowBubblewrapArgs(release,scratch,binary,productionPort);
    const output=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
      child=spawn("/usr/bin/bwrap",args,{
        env:{...operatorEnvironment(),PATH:"/usr/bin:/bin"},
        stdio:["ignore","pipe","pipe"],
      });
      let stdout="",stderr="",bytes=0,settled=false;
      const finish=(err?:Error,code?:number|null)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        if(err)reject(err);else resolve({code:code??null,stdout,stderr});
      };
      const timer=setTimeout(()=>{
        child?.kill("SIGKILL");
        finish(Error("UPDATE_SHADOW_TIMEOUT: no live gateway change was attempted"));
      },120_000);
      timer.unref();
      const grab=(data:Buffer,which:"stdout"|"stderr")=>{
        bytes+=data.length;
        if(bytes>65536){child?.kill("SIGKILL");finish(Error("UPDATE_SHADOW_OUTPUT_LIMIT"));return;}
        if(which==="stdout")stdout+=data.toString();else stderr+=data.toString();
      };
      child.stdout!.on("data",(b:Buffer)=>grab(b,"stdout"));
      child.stderr!.on("data",(b:Buffer)=>grab(b,"stderr"));
      child.on("error",err=>finish(Error("UPDATE_SHADOW_SANDBOX_UNAVAILABLE: "+(err as NodeJS.ErrnoException).code)));
      child.on("close",code=>finish(undefined,code));
    });
    if(output.code!==0){
      const category=/SHADOW_[A-Z_]+/.exec(output.stderr)?.[0]||"UPDATE_SHADOW_SANDBOX_UNAVAILABLE";
      throw Error(category+": shadow could not prove isolation/denials; no cutover");
    }
    let receipt:unknown;
    try{receipt=JSON.parse(output.stdout.trim());}catch{throw Error("UPDATE_SHADOW_RECEIPT_INVALID");}
    const r=receipt as Partial<ShadowReceipt>;
    if(r.ok!==true||r.native!==52||r.read_tools!>=0||
       r.production_secrets_inaccessible!==true||r.production_network_isolated!==true||
       !r.checks||!r.checks.privilege_and_destructive_denied||
       !r.checks.second_client_no_root||!r.checks.admin_authentication_and_isolation||
       !r.checks.all_read_schemas||!r.checks.reviewed_provider_inventory)
      throw Error("UPDATE_SHADOW_ACCEPTANCE_FAILED");
    return r as ShadowReceipt;
  }finally{
    if(child && child.exitCode===null){
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>(resolve=>child!.once("close",()=>resolve())),
        new Promise<void>(resolve=>setTimeout(resolve,1500))
      ]);
      if(child.exitCode===null)child.kill("SIGKILL");
      if(child.exitCode===null)await Promise.race([
        new Promise<void>(resolve=>child!.once("close",()=>resolve())),
        new Promise<void>(resolve=>setTimeout(resolve,2000))
      ]);
    }
    await fs.rm(scratch,{recursive:true,force:true});
  }
}
export function shadowReceiptHash(receipt:ShadowReceipt):string{
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}
