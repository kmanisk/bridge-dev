import fs from "node:fs";
import path from "node:path";
import {ExtensionStore,type Scope} from "./extension-store.js";
import {SourceCatalog} from "./extension-sources.js";
import {McpUpstreamManager} from "./mcp-upstream-manager.js";
import {redactAudit} from "./hash-audit.js";

export async function operatorApi(route:string,body?:unknown):Promise<any>{
 let token=process.env.ADMIN_TOKEN||"";
 if(!token && process.env.BRIDGEDEV_ADMIN_TOKEN_FILE){const file=process.env.BRIDGEDEV_ADMIN_TOKEN_FILE,st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(process.platform!=="win32"&&(st.mode&0o077)))throw new Error("ADMIN_TOKEN_FILE_MUST_BE_PRIVATE");token=fs.readFileSync(file,"utf8").trim();}
 if(!token)throw new Error("OPERATOR_AUTH_REQUIRED: set the independent ADMIN_TOKEN or BRIDGEDEV_ADMIN_TOKEN_FILE in an operator terminal");
 const base=new URL(process.env.BRIDGEDEV_ADMIN_URL||`http://127.0.0.1:${process.env.ADMIN_PORT||3001}`);
 if(!["127.0.0.1","localhost","[::1]"].includes(base.hostname)||base.username||base.password)throw new Error("Operator API must be loopback");
 const response=await fetch(new URL(route,base),{method:body===undefined?"GET":"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const data=await response.json();if(!response.ok)throw new Error(data.error||"Operator API failed");return data.data??data;
}
export async function extensionCli(args:string[],json=false):Promise<boolean>{
 const group=args[0];if(!["add","mcp","skills","instructions","pack","approve"].includes(group))return false;
 const flag=(name:string)=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
 const scope=(flag("--scope")||"project") as Scope;if(!["user","project"].includes(scope))throw new Error("--scope must be user or project");
 const plain=args.filter((arg,i)=>!arg.startsWith("--") && !(i>0&&["--scope","--select","--tools","--permission"].includes(args[i-1])));
 const action=group==="add"?"add":group==="approve"?"approve":plain[1]||"list",target=group==="add"||group==="approve"?plain[1]:plain[2];
 const manager=new McpUpstreamManager();await manager.init();const store=new ExtensionStore(undefined,undefined,manager);
 const kind=group==="skills"?"skill":group==="instructions"?"instructions":group==="pack"?"pack":"mcp";
 const key=target?.includes(":")?target:kind+":"+target;
 let result:any;
 try{
 if(action==="approve"){
  if(!target)throw new Error("Usage: bridge-dev approve <exact-proposal-id>");
  result=await operatorApi("/api/extensions/apply",{id:target});
 }else if(action==="add"||action==="import"){
  if(!target)throw new Error("Source required");
  let selection=flag("--select")?.split(",");
  if(group!=="add"&&!selection){const discovery=await store.catalog.discover(target),candidates=discovery.components.filter(c=>c.kind===kind);if(candidates.length===1)selection=[kind+":"+candidates[0].id];else if(!candidates.length)throw new Error("SOURCE_KIND_MISMATCH: no "+kind+" candidates");}
  result=await store.propose(target,selection,scope);
 }else if(action==="list"||action==="sources"||action==="search"){
  const entries=(await store.list()).filter(entry=>group==="add"||entry.component.kind===kind);
  result=action==="sources"?[...new Set(entries.map(e=>e.source))]:entries.filter(e=>action!=="search"||JSON.stringify([e.key,e.component.description]).toLowerCase().includes((target||"").toLowerCase()));
  if(group==="mcp")result={registered:manager.listStatusesCached(),installed:result,registry_error:manager.initializationError,search_scope:"installed metadata; external registry search not configured"};
 }else if(action==="validate")result=await store.validate();
 else if(action==="logs")result=await operatorApi("/api/extensions/provider-logs?name="+encodeURIComponent(target||""));
 else if(action==="status")result={providers:manager.listStatusesCached(),registry_error:manager.initializationError};
 else if(action==="export")result=manager.getConfig();
 else if(action==="test")result=await operatorApi("/api/extensions/provider-test",{name:target});
 else if(action==="tools")result=await operatorApi("/api/extensions/provider-tools?name="+encodeURIComponent(target||""));
 else if(action==="info"){
  if(!target)throw new Error("Name or source required");
  const installed=(await store.list()).find(e=>e.key===key||e.component.id===target);
  result=installed||manager.getServerConfig(target)||await new SourceCatalog().discover(target);
 }else if(action==="enable"&&group==="mcp"){
  if(!target)throw new Error("Provider name required");
  const tools=(flag("--tools")||"").split(",").filter(Boolean),permission=flag("--permission")||"X";
  if(!["R","W","X"].includes(permission))throw new Error("--permission must be R, W or X; R is an operator assertion, never inferred from descriptions");
  result=await store.proposeProvider(target,{enabled:true,expose:"allowlist",tools,tool_permissions:Object.fromEntries(tools.map(name=>[name,permission as "R"|"W"|"X"])),...(args.includes("--allow-private-network")?{allow_private_network:true}:{})});
 }else if(action==="disable"&&group==="mcp")result=await store.proposeProvider(target!,{enabled:false});
 else if(action==="remove"&&group==="mcp"&&!(await store.list()).some(e=>e.key===key))result=await store.proposeProviderRemoval(target!);
 else if(["remove","disable","enable","update"].includes(action)){
  if(args.includes("--all")&&action==="update"){
   result=[];for(const entry of (await store.list()).filter(e=>e.component.kind===kind))result.push(await store.proposeAction("update",entry.key,entry.scope));
  }else{if(!target)throw new Error("Extension name required");result=await store.proposeAction(action as any,key,scope);}
 }else throw new Error("Unsupported extension command: "+action);
 const safe=redactAudit(result);
 if(json)console.log(JSON.stringify({ok:true,data:safe}));
 else{
  console.log(JSON.stringify(safe,null,2));
  if(result?.id)console.log("Review the exact proposal, then run: bridge-dev approve "+result.id);
  if(result?.components&&!result.id)console.log("Select components with --select kind:name[,kind:name]. No component was installed.");
 }
 return true;
 }finally{await manager.shutdown();}
}
