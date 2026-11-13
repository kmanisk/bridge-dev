import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const CONTROLLER="/usr/local/bin/bridge-dev-controller";
export function hostControllerAvailable():boolean {
  // Isolated suites can only reduce privilege; they never contact an installed helper.
  return !process.env.BRIDGEDEV_TEST_ROOT&&process.platform==="linux"&&fs.existsSync(CONTROLLER);
}
export function controllerCall(action:string,args:string[]=[],input?:unknown):Promise<any>{
  if(!hostControllerAvailable())throw new Error("HOST_CONTROLLER_UNAVAILABLE: independent operator must install the Linux host controller");
  return new Promise((resolve,reject)=>{
    const child=spawn("/usr/bin/sudo",["-n","--",CONTROLLER,action,...args],{env:{PATH:"/usr/bin:/bin",LANG:"C.UTF-8"},stdio:["pipe","pipe","pipe"]});
    let stdout="",stderr="",size=0;
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("CONTROLLER_TIMEOUT: inspect existing job before retry"));},45_000);timer.unref();
    const capture=(which:"out"|"err",data:Buffer)=>{size+=data.length;if(size>3*1048576){child.kill("SIGKILL");return;}if(which==="out")stdout+=data;else stderr+=data;};
    child.stdout.on("data",b=>capture("out",b));child.stderr.on("data",b=>capture("err",b));
    child.on("error",error=>{clearTimeout(timer);reject(error);});
    child.on("close",code=>{clearTimeout(timer);if(code!==0)return reject(new Error(stderr||"Controller exited "+code));try{resolve(JSON.parse(stdout));}catch{reject(new Error("Invalid controller receipt"));}});
    child.stdin.on("error",()=>{});child.stdin.end(input===undefined?undefined:JSON.stringify(input));
  });
}
export async function executeHostCommand(command:string,cwd:string,timeout:number,approvalId?:string):Promise<Record<string,unknown>>{
  const request_id=randomUUID();
  const submitted=await controllerCall("submit",[],{kind:"exec",request_id,argv:["/bin/bash","-c",command],cwd,timeout,...(approvalId?{approval_id:approvalId}:{})});
  const deadline=Date.now()+Math.min(timeout,120)*1000;
  let result=submitted;
  while(["PENDING","RUNNING"].includes(result.status)&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,250));result=await controllerCall("status",[submitted.job_id]);
  }
  let output={stdout:"",stderr:""};
  try{output=await controllerCall("logs",[submitted.job_id]);}catch{output.stderr="Lease ended; protected output requires renewed operator authorization.";}
  return {...output,exit_code:result.exit_code??null,cwd,timed_out:["PENDING","RUNNING"].includes(result.status),job_id:submitted.job_id,job_status:result.status,log_path:submitted.log_path,request_id};
}
