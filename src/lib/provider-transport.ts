import {fileURLToPath} from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Explicit environment. Windows libuv defaults are blanked; only configured OS essentials survive. */
export class ProviderTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: ()=>void;
  onerror?: (error:Error)=>void;
  private child?:ChildProcessWithoutNullStreams;
  private closing?:Promise<void>;
  stderr="";
  get pid():number|null{return this.child?.pid || null;}
  constructor(private options:{command:string;args?:string[];env?:Record<string,string>;cwd?:string}){}
  async start():Promise<void>{
    const env:Record<string,string>={...(this.options.env||{})};
    if(process.platform==="win32"){
      for(const key of ["HOMEDRIVE","HOMEPATH","LOGONSERVER","PATH","SYSTEMDRIVE","SYSTEMROOT","TEMP","USERDOMAIN","USERNAME","USERPROFILE","WINDIR"]){
        if(!Object.keys(env).some(name=>name.toUpperCase()===key))env[key]="";
      }
    }
    const child=spawn(this.options.command,this.options.args || [],{cwd:this.options.cwd,env,shell:false,detached:process.platform!=="win32",stdio:"pipe",windowsHide:true});
    this.child=child;
    const buffer=new ReadBuffer({maxBufferSize:4*1024*1024});
    child.stdout.on("data",chunk=>{try {buffer.append(chunk);let message;while((message=buffer.readMessage())!==null)this.onmessage?.(message);}catch(error){this.onerror?.(error as Error);void this.close();}});
    child.stderr.on("data",chunk=>{this.stderr=(this.stderr+chunk.toString()).slice(-16384);});
    child.on("close",()=>this.onclose?.());
    child.stdin.on("error",error=>this.onerror?.(error));
    await new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);});
  }
  async send(message:JSONRPCMessage):Promise<void>{
    const child=this.child;
    if(!child || child.exitCode!==null)throw new Error("PROVIDER_CLOSED");
    await new Promise<void>((resolve,reject)=>child.stdin.write(serializeMessage(message),error=>error?reject(error):resolve()));
  }
  close():Promise<void>{return this.closing ??= this.stopTree();}
  private async stopTree():Promise<void>{
    const child=this.child,pid=child?.pid;
    if(!child || !pid)return;
    if(process.platform==="win32"){
      const cleanupEnv={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,BRIDGEDEV_CLEANUP_PID:String(pid)};
      let cleanupError="";
      const run=(executable:string,args:string[])=>new Promise<boolean>(resolve=>{
        const killer=spawn(executable,args,{stdio:["ignore","ignore","pipe"],windowsHide:true,timeout:10000,env:cleanupEnv});
        let detail="";killer.stderr?.on("data",chunk=>{detail=(detail+chunk.toString()).slice(-2000);});
        killer.on("error",error=>{cleanupError=error.message;resolve(false);});killer.on("close",(code,signal)=>{if(code!==0)cleanupError=executable+" exit="+code+" signal="+signal+" "+detail;resolve(code===0);});
      });
      let stopped=false;
      if(child.exitCode===null&&!child.signalCode)stopped=await run("taskkill.exe",["/PID",String(pid),"/T","/F"]);
      // A native local snapshot retains ancestry after a crash, unlike taskkill /T.
      if(!stopped){
        const script=fileURLToPath(new URL("../../platform/windows-provider-cleanup.ps1",import.meta.url));
        if(!await run("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-RootProcessId",String(pid)]))throw new Error("PROVIDER_TREE_CLEANUP_FAILED: native Windows snapshot helper failed: "+cleanupError);
      }
      if(child.exitCode===null&&!child.signalCode)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("PROVIDER_EXIT_TIMEOUT")),3000);child.once("exit",()=>{clearTimeout(timer);resolve();});});
    }else{
      try{process.kill(-pid,"SIGTERM");}catch{}
      await new Promise(resolve=>setTimeout(resolve,150));
      try{process.kill(-pid,"SIGKILL");}catch{}
    }
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  }
}
