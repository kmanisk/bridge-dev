import {installReviewedPackage} from "./package-install.js";
import fs from "node:fs/promises";
import path from "node:path";
import {atomicJson,withFileLock} from "./atomic-store.js";
import {SourceCatalog,sha256,type Discovery,type ExtensionComponent} from "./extension-sources.js";
import {portableStateDir,portableWorkspace} from "./runtime.js";
import type {McpUpstreamManager} from "./mcp-upstream-manager.js";
export type Scope="user"|"project";
export interface InstalledExtension {
 key:string;scope:Scope;source:string;adapter:string;resolved:string;digest:string;
 component:ExtensionComponent;enabled:boolean;installed_at:string;
}
export interface ExtensionLock {version:1;entries:InstalledExtension[];}
export interface Proposal {
 version:1;id:string;action:"add"|"remove"|"enable"|"disable"|"update";
 scope:Scope;key?:string;discovery?:Discovery;selection?:string[];expected?:string;created_at:number;
}
export class ExtensionStore {
 readonly root:string;
 constructor(readonly workspace=portableWorkspace(),readonly catalog=new SourceCatalog(),private manager?:McpUpstreamManager){this.root=path.join(portableStateDir(),"extensions");}
 scopeRoot(scope:Scope):string{return scope==="user"?path.join(this.root,"user"):path.join(this.workspace,".bridge-dev","managed");}
 private lockPath(scope:Scope):string{return path.join(this.scopeRoot(scope),"lock.json");}
 async read(scope:Scope):Promise<ExtensionLock>{
  try{const stat=await fs.lstat(this.lockPath(scope));if(stat.isSymbolicLink()||stat.size>16*1048576)throw new Error("EXTENSION_LOCK_UNSAFE");
   const raw=JSON.parse(await fs.readFile(this.lockPath(scope),"utf8"));
   if(raw.version!==1||!Array.isArray(raw.entries))throw new Error("EXTENSION_LOCK_VERSION_OR_SCHEMA_INVALID");return raw;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {version:1,entries:[]};throw error;}
 }
 async list():Promise<(InstalledExtension&{overrides_user?:boolean})[]>{
  const [user,project]=await Promise.all([this.read("user"),this.read("project")]);
  const map=new Map(user.entries.map(entry=>[entry.key,entry]));
  for(const entry of project.entries)map.set(entry.key,{...entry,overrides_user:map.has(entry.key)} as InstalledExtension);
  return [...map.values()];
 }
 async propose(source:string,selection?:string[],scope:Scope="project"):Promise<Proposal|Discovery>{
  const discovery=await this.catalog.discover(source);
  if(!selection && discovery.components.length!==1)return discovery;
  const selected=selection || [discovery.components[0].kind+":"+discovery.components[0].id];
  if(!selected.length || selected.some(key=>!discovery.components.some(c=>c.kind+":"+c.id===key)))throw new Error("COMPONENT_SELECTION_INVALID");
  return this.saveProposal({version:1,action:"add",scope,discovery,selection:selected,created_at:Date.now()});
 }
 async proposeAction(action:Proposal["action"],key:string,scope:Scope="project"):Promise<Proposal>{
  const entry=(await this.read(scope)).entries.find(item=>item.key===key);if(!entry)throw new Error("EXTENSION_NOT_FOUND_IN_SCOPE");
  if(action==="update"){
   const discovery=await this.catalog.discover(entry.source);
   if(!discovery.components.some(c=>c.kind+":"+c.id===key))throw new Error("UPDATE_COMPONENT_MISSING");
   return this.saveProposal({version:1,action,scope,key,discovery,selection:[key],expected:entry.digest,created_at:Date.now()});
  }
  return this.saveProposal({version:1,action,scope,key,expected:entry.digest,created_at:Date.now()});
 }
 private async saveProposal(value:Omit<Proposal,"id">):Promise<Proposal>{
  const id=sha256(JSON.stringify(value));const proposal={...value,id};
  await atomicJson(path.join(this.root,"proposals",id+".json"),proposal);return proposal;
 }
 async proposal(id:string):Promise<Proposal>{
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error("PROPOSAL_ID_INVALID");
  const proposal=JSON.parse(await fs.readFile(path.join(this.root,"proposals",id+".json"),"utf8")) as Proposal;
  const {id:saved,...value}=proposal;
  if(saved!==id||sha256(JSON.stringify(value))!==id||Date.now()-proposal.created_at>3600000)throw new Error("PROPOSAL_CHANGED_OR_EXPIRED");
  return proposal;
 }
 /** Operator boundary: only CLI/admin call this; MCP exposes proposals only. */
 async apply(id:string):Promise<ExtensionLock>{
  const proposal=await this.proposal(id);
  return withFileLock(path.join(this.root,"transaction"),async()=>{
   const current=await this.read(proposal.scope);
   const old=current.entries.find(entry=>entry.key===proposal.key);
   if(proposal.expected && old?.digest!==proposal.expected)throw new Error("PROPOSAL_STALE: regenerate against current state");
   let entries=structuredClone(current.entries);
   if(proposal.action==="remove")entries=entries.filter(entry=>entry.key!==proposal.key);
   else if(proposal.action==="enable"||proposal.action==="disable"){
    if(!old)throw new Error("EXTENSION_NOT_FOUND");
    if(old.component.kind==="mcp" && proposal.action==="enable")throw new Error("MCP_ENABLE_REQUIRES_PROVIDER_REVIEW: use the operator MCP configuration with explicit tool allowlist");
    entries=entries.map(entry=>entry.key===proposal.key?{...entry,enabled:proposal.action==="enable"}:entry);
   }else{
    const discovery=proposal.discovery!;
    for(const component of discovery.components.filter(c=>proposal.selection!.includes(c.kind+":"+c.id))){
     if(component.package)component.provider=await installReviewedPackage(component,path.join(this.scopeRoot(proposal.scope),"packages",discovery.digest,component.id));
     const key=component.kind+":"+component.id;
     if(proposal.action==="add" && entries.some(entry=>entry.key===key))throw new Error("EXTENSION_EXISTS: use update");
     if(component.kind!=="mcp")throw new Error("CONTENT_INSTALL_NOT_AVAILABLE");
     entries=entries.filter(entry=>entry.key!==key);
     entries.push({key,scope:proposal.scope,source:discovery.source,adapter:discovery.adapter,resolved:discovery.resolved,digest:discovery.digest,component,enabled:false,installed_at:new Date().toISOString()});
    }
   }
   if(this.manager){
    const providers=entries.filter(entry=>entry.component.kind==="mcp").map(entry=>entry.component.provider!).filter(Boolean);
    const oldIds=new Set(current.entries.filter(entry=>entry.component.kind==="mcp").map(entry=>entry.component.id));
    const config=this.manager.getConfig();
    const previous=config.servers;
    const next={version:1 as const,servers:[...previous.filter(server=>!oldIds.has(server.id)),...providers]};
    await this.manager.updateConfig(next);
    try{await atomicJson(this.lockPath(proposal.scope),{version:1,entries});}
    catch(error){await this.manager.updateConfig(config);throw error;}
   }else await atomicJson(this.lockPath(proposal.scope),{version:1,entries});
   await fs.rename(path.join(this.root,"proposals",id+".json"),path.join(this.root,"proposals",id+".used.json"));
   return {version:1,entries};
  });
 }
}
