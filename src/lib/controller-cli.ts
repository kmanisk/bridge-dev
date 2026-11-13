import {controllerCall,hostControllerAvailable} from "./host-controller.js";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import fs from "node:fs";

export async function controllerCli(args:string[],json:boolean):Promise<boolean>{
  if(!["operator","deploy"].includes(args[0]))return false;
  if(!hostControllerAvailable())throw new Error("HOST_CONTROLLER_UNAVAILABLE: optional managed Linux operator component is not installed");
  const flag=(name:string)=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
  const group=args[0],action=args[1]||"status";let result:any;
  if(group==="operator"&&action==="yolo"){
    const script="/usr/local/libexec/bridge-dev/policygate-operator.mjs";
    if(!fs.existsSync(script))throw new Error("Independent operator script is not installed");
    const off=args[2]==="off";
    if(!off&&args[2]!=="on")throw new Error("Usage: bridge-dev operator yolo on --duration 60 | off");
    const call=spawnSync("/usr/bin/sudo",["--",process.execPath,script,"yolo",...(off?["--off"]:["--duration",flag("--duration")||"30"])],{stdio:"inherit"});
    if(call.status!==0)throw new Error("Independent operator authorization required");return true;
  }
  if(group==="operator"&&action==="exec"){
    const at=args.indexOf("--");if(at<0||!args[at+1]?.startsWith("/"))throw new Error("Usage: bridge-dev operator exec [--request-id UUID] [--cwd PATH] -- /absolute/executable args...");
    result=await controllerCall("submit",[],{kind:"exec",request_id:flag("--request-id")||randomUUID(),argv:args.slice(at+1),cwd:flag("--cwd")||process.cwd(),timeout:Number(flag("--timeout")||120),...(flag("--approval-id")?{approval_id:flag("--approval-id")}:{} )});
  }else if(group==="deploy"&&["plan","start"].includes(action)){
    const release=flag("--release");if(!release?.startsWith("/"))throw new Error("--release must name an immutable root-owned staged release");
    const plan={kind:"deploy",request_id:flag("--request-id")||randomUUID(),release};
    result=action==="plan"?{...plan,requires:"independent operator YOLO lease",checks:["root-owned payload","serialized deployment","rollback watchdog","health","independent MCP acceptance","protected state"],changes:["stop gateway","atomically exchange installed directory","start same unit"],rollback:"automatic on failure/timeout; previous directory preserved"}:await controllerCall("submit",[],plan);
  }else if(["status","logs","verify","rollback","cleanup"].includes(action)){
    const id=args[2];if(["logs","verify","rollback","cleanup"].includes(action)&&!id)throw new Error("Job ID required");
    result=await controllerCall(action==="verify"?"status":action,id?[id]:[]);
    if(action==="verify"&&result.status!=="SUCCESS")throw new Error("Job has not passed acceptance: "+result.status);
  }else throw new Error("Usage: bridge-dev operator status|yolo|exec|logs|cleanup; bridge-dev deploy plan|start|status|logs|verify|rollback|cleanup");
  console.log(JSON.stringify(json?{ok:true,data:result}:result,null,json?undefined:2));return true;
}
