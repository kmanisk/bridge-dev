import {installReviewedPackage} from "./package-install.js";
import fs from "node:fs/promises";
import path from "node:path";
import {atomicJson,withFileLock} from "./atomic-store.js";
import {SourceCatalog,sha256,safeRelative,componentId,validateSkill,type Discovery,type ExtensionComponent} from "./extension-sources.js";
import {portableStateDir,portableWorkspace} from "./runtime.js";
import {normalizeConfig,type UpstreamServerConfig} from "./mcp-upstream-config.js";
import type {McpUpstreamManager} from "./mcp-upstream-manager.js";
export type Scope="user"|"project";
export interface InstalledExtension {
 key:string;scope:Scope;source:string;adapter:string;resolved:string;digest:string;
 component:ExtensionComponent;enabled:boolean;installed_at:string;pack_parent?:string;
}
export interface ExtensionLock {version:1;entries:InstalledExtension[];}
export interface Proposal {
 version:1;id:string;workspace:string;action:"add"|"remove"|"enable"|"disable"|"update";
 scope:Scope;key?:string;discovery?:Discovery;selection?:string[];expected?:string;provider?:UpstreamServerConfig;provider_expected?:string;created_at:number;
}
export class ExtensionStore {
 readonly root:string;
 constructor(readonly workspace=portableWorkspace(),readonly catalog=new SourceCatalog(),private manager?:McpUpstreamManager){this.root=path.join(portableStateDir(),"extensions");}
 scopeRoot(scope:Scope):string{return scope==="user"?path.join(this.root,"user"):path.join(this.workspace,".bridge-dev","managed");}
 private lockPath(scope:Scope):string{return path.join(this.scopeRoot(scope),"lock.json");}
 async read(scope:Scope):Promise<ExtensionLock>{
  try{const stat=await fs.lstat(this.lockPath(scope));if(stat.isSymbolicLink()||stat.size>16*1048576)throw new Error("EXTENSION_LOCK_UNSAFE");
   const raw=JSON.parse(await fs.readFile(this.lockPath(scope),"utf8"));
   if(raw.version!==1||!Array.isArray(raw.entries)||raw.entries.length>256)throw new Error("EXTENSION_LOCK_VERSION_OR_SCHEMA_INVALID");
   for(const entry of raw.entries){
    if(!entry.component || componentId(entry.component.id)!==entry.component.id || !["mcp","skill","instructions","pack"].includes(entry.component.kind) || entry.key!==entry.component.kind+":"+entry.component.id || !/^[a-f0-9]{64}$/.test(entry.digest) || entry.scope!==scope || typeof entry.enabled!=="boolean")throw new Error("EXTENSION_LOCK_ENTRY_INVALID");
    for(const [file,content] of Object.entries(entry.component.files)){safeRelative(file);if(typeof content!=="string"||Buffer.byteLength(content)>1048576)throw new Error("EXTENSION_LOCK_CONTENT_INVALID");}
   }
   return raw;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {version:1,entries:[]};throw error;}
 }
 contentDirectory(scope:Scope,digest:string,id:string,kind="skill"):string{return path.join(this.scopeRoot(scope),"content",digest,kind+"-"+id);}
 async content(key:string):Promise<{entry:InstalledExtension;files:Record<string,string>;untrusted:true}>{
  const entry=(await this.list()).find(item=>item.key===key&&item.enabled);if(!entry)throw new Error("EXTENSION_DISABLED_OR_MISSING");
  return {entry,files:entry.component.files,untrusted:true};
 }
 async validate():Promise<{key:string;valid:boolean;error?:string}[]>{
  return (await this.list()).filter(entry=>entry.component.kind==="skill").map(entry=>{try{validateSkill(entry.component.files["SKILL.md"],entry.component.files);return {key:entry.key,valid:true};}catch(error){return {key:entry.key,valid:false,error:String(error)};}});
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
  for(const key of [...selected]){
    const pack=discovery.components.find(c=>c.kind+":"+c.id===key&&c.kind==="pack");
    for(const member of pack?.members||[])if(!selected.includes(member))selected.push(member);
  }
  if(!selected.length || selected.some(key=>!discovery.components.some(c=>c.kind+":"+c.id===key)))throw new Error("COMPONENT_SELECTION_INVALID");
  return this.saveProposal({version:1,action:"add",scope,discovery,selection:selected,created_at:Date.now()});
 }
 async proposeAction(action:Proposal["action"],key:string,scope:Scope="project"):Promise<Proposal>{
  const entry=(await this.read(scope)).entries.find(item=>item.key===key);if(!entry)throw new Error("EXTENSION_NOT_FOUND_IN_SCOPE");
  if(action==="disable"&&entry.component.kind==="mcp"&&this.manager)return this.proposeProvider(entry.component.id,{enabled:false});
  if(action==="update"){
   const discovery=await this.catalog.discover(entry.source);
   if(!discovery.components.some(c=>c.kind+":"+c.id===key))throw new Error("UPDATE_COMPONENT_MISSING");
   const component=discovery.components.find(c=>c.kind+":"+c.id===key)!;
   return this.saveProposal({version:1,action,scope,key,discovery,selection:[key,...(component.members||[])],expected:entry.digest,created_at:Date.now()});
  }
  return this.saveProposal({version:1,action,scope,key,expected:entry.digest,created_at:Date.now()});
 }
 async proposeProviderRemoval(id:string):Promise<Proposal>{
  const current=this.manager?.getServerConfig(id);if(!current)throw new Error("PROVIDER_NOT_FOUND");
  return this.saveProposal({version:1,action:"remove",scope:"project",key:"mcp:"+id,provider:current,provider_expected:sha256(JSON.stringify(current)),created_at:Date.now()});
 }
 async proposeProvider(id:string,changes:Partial<UpstreamServerConfig>):Promise<Proposal>{
  const current=this.manager?.getServerConfig(id);if(!current)throw new Error("PROVIDER_NOT_FOUND");
  const provider=normalizeConfig({version:1,servers:[{...current,...changes,id:current.id}]}).servers[0];
  const installed=(await this.list()).find(entry=>entry.key==="mcp:"+id);
  return this.saveProposal({version:1,action:provider.enabled?"enable":"disable",scope:installed?.scope||"project",key:"mcp:"+id,provider:provider,provider_expected:sha256(JSON.stringify(current)),created_at:Date.now()});
 }
 async request(value:{action:string;source?:string;key?:string;selection?:string[];scope:Scope}):Promise<{id:string;operator_review_required:true}>{
  if(!["add","remove","update","disable"].includes(value.action)||!["user","project"].includes(value.scope)||JSON.stringify(value).length>4096)throw new Error("EXTENSION_REQUEST_INVALID");
  const data={...value,workspace:await fs.realpath(this.workspace),created_at:Date.now()},id=sha256(JSON.stringify(data));await atomicJson(path.join(this.root,"requests",id+".json"),data);return {id,operator_review_required:true};
 }
 async requests():Promise<unknown[]>{
  const directory=path.join(this.root,"requests");const files=await fs.readdir(directory).catch(()=>[]);
  const records=await Promise.all(files.filter(file=>/^[a-f0-9]{64}\.json$/.test(file)).slice(0,100).map(async file=>({id:file.slice(0,-5),...JSON.parse(await fs.readFile(path.join(directory,file),"utf8"))})));
  const workspace=await fs.realpath(this.workspace);return records.filter(record=>record.workspace===workspace);
 }
 async reviewRequest(id:string):Promise<Proposal|Discovery>{
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error("REQUEST_ID_INVALID");
  const request=JSON.parse(await fs.readFile(path.join(this.root,"requests",id+".json"),"utf8"));
  if(sha256(JSON.stringify(request))!==id)throw new Error("REQUEST_CHANGED");
  if(request.workspace!==await fs.realpath(this.workspace))throw new Error("REQUEST_WORKSPACE_CHANGED");
  let result:Proposal|Discovery;
  if(request.action==="add")result=await this.propose(request.source,request.selection,request.scope);
  else if(request.action==="disable"&&request.key?.startsWith("mcp:"))result=await this.proposeProvider(request.key.slice(4),{enabled:false});
  else if(request.action==="remove"&&request.key?.startsWith("mcp:")&&!(await this.read(request.scope)).entries.some(e=>e.key===request.key))result=await this.proposeProviderRemoval(request.key.slice(4));
  else result=await this.proposeAction(request.action,request.key,request.scope);
  await fs.rm(path.join(this.root,"requests",id+".json"));return result;
 }
 private async saveProposal(value:Omit<Proposal,"id"|"workspace">):Promise<Proposal>{
  const body={...value,workspace:await fs.realpath(this.workspace)};
  const id=sha256(JSON.stringify(body));const proposal={...body,id};
  await atomicJson(path.join(this.root,"proposals",id+".json"),proposal);return proposal;
 }
 async proposal(id:string):Promise<Proposal>{
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error("PROPOSAL_ID_INVALID");
  const proposal=JSON.parse(await fs.readFile(path.join(this.root,"proposals",id+".json"),"utf8")) as Proposal;
  const {id:saved,...value}=proposal;
  if(saved!==id||sha256(JSON.stringify(value))!==id||Date.now()-proposal.created_at>3600000)throw new Error("PROPOSAL_CHANGED_OR_EXPIRED");
  if(proposal.workspace!==await fs.realpath(this.workspace))throw new Error("PROPOSAL_WORKSPACE_CHANGED: review the proposal in its original workspace");
  return proposal;
 }
 /** Operator boundary: only CLI/admin call this; MCP exposes proposals only. */
 async apply(id:string):Promise<ExtensionLock>{
  const proposal=await this.proposal(id);
  return withFileLock(path.join(this.root,"transaction"),async()=>{
   const current=await this.read(proposal.scope);
   if(proposal.provider){
     if(!this.manager || sha256(JSON.stringify(this.manager.getServerConfig(proposal.provider.id)))!==proposal.provider_expected)throw new Error("PROVIDER_PROPOSAL_STALE");
     if(proposal.action==="remove")await this.manager.removeServer(proposal.provider.id);else await this.manager.upsertServer(proposal.provider);
     const next={version:1 as const,entries:current.entries.map(entry=>entry.key===proposal.key?{...entry,component:{...entry.component,provider:proposal.provider},enabled:proposal.provider!.enabled}:entry)};
     await atomicJson(this.lockPath(proposal.scope),next);
     await fs.rename(path.join(this.root,"proposals",id+".json"),path.join(this.root,"proposals",id+".used.json"));return next;
   }
   const old=current.entries.find(entry=>entry.key===proposal.key);
   if(proposal.expected && old?.digest!==proposal.expected)throw new Error("PROPOSAL_STALE: regenerate against current state");
   let entries=structuredClone(current.entries);
   if(proposal.action==="remove")entries=entries.filter(entry=>entry.key!==proposal.key&&entry.pack_parent!==proposal.key);
   else if(proposal.action==="enable"||proposal.action==="disable"){
    if(!old)throw new Error("EXTENSION_NOT_FOUND");
    if(old.component.kind==="mcp" && proposal.action==="enable")throw new Error("MCP_ENABLE_REQUIRES_PROVIDER_REVIEW: use the operator MCP configuration with explicit tool allowlist");
    entries=entries.map(entry=>entry.key===proposal.key?{...entry,enabled:proposal.action==="enable"}:entry);
   }else{
    const discovery=proposal.discovery!;
    if(proposal.action==="update" && old?.component.kind==="pack")entries=entries.filter(entry=>entry.pack_parent!==old.key);
    for(const component of discovery.components.filter(c=>proposal.selection!.includes(c.kind+":"+c.id))){
     if(component.package)component.provider=await installReviewedPackage(component,path.join(this.scopeRoot(proposal.scope),"packages",discovery.digest,component.id));
     const key=component.kind+":"+component.id;
     if(proposal.action==="add" && entries.some(entry=>entry.key===key))throw new Error("EXTENSION_EXISTS: use update");
     if(component.kind==="skill")validateSkill(component.files["SKILL.md"],component.files);
     if(component.kind!=="mcp"){
       const destination=this.contentDirectory(proposal.scope,discovery.digest,component.id,component.kind);
       await fs.mkdir(destination,{recursive:true,mode:0o700});
       for(const [filename,text]of Object.entries(component.files)){
        safeRelative(filename);const target=path.join(destination,filename);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
        await fs.writeFile(target,text,{mode:0o600,flag:"wx"}).catch(async(error:NodeJS.ErrnoException)=>{if(error.code!=="EEXIST")throw error;if(await fs.readFile(target,"utf8")!==text)throw new Error("INSTALLED_CONTENT_CHANGED");});
       }
     }
     const parent=entries.find(entry=>entry.key===key)?.pack_parent;
     entries=entries.filter(entry=>entry.key!==key);
     entries.push({key,scope:proposal.scope,source:discovery.source,adapter:discovery.adapter,resolved:discovery.resolved,digest:discovery.digest,component,enabled:false,installed_at:new Date().toISOString(),...(parent?{pack_parent:parent}:{}),...(discovery.components.find(c=>c.kind==="pack"&&proposal.selection!.includes("pack:"+c.id)&&c.members?.includes(key))?{pack_parent:"pack:"+discovery.components.find(c=>c.kind==="pack"&&c.members?.includes(key))!.id}:{})});
    }
   }
   if(this.manager){
    const other=await this.read(proposal.scope==="user"?"project":"user");
    const effectiveEntries=(scopeEntries:InstalledExtension[])=>new Map((proposal.scope==="user"?[...scopeEntries,...other.entries]:[...other.entries,...scopeEntries]).map(entry=>[entry.key,entry]));
    const effective=effectiveEntries(entries),before=effectiveEntries(current.entries);
    const providers=[...effective.values()].filter(entry=>entry.component.kind==="mcp").map(entry=>{
      const previous=before.get(entry.key);
      const unchanged=previous?.scope===entry.scope&&previous?.digest===entry.digest;
      const renewed=proposal.action==="update"&&entry.scope===proposal.scope&&proposal.selection?.includes(entry.key);
      return unchanged&&!renewed ? this.manager!.getServerConfig(entry.component.id)||entry.component.provider! : entry.component.provider!;
    }).filter(Boolean);
    const oldIds=new Set([...current.entries,...other.entries].filter(entry=>entry.component.kind==="mcp").map(entry=>entry.component.id));
    const config=this.manager.getConfig();
    const previous=config.servers;
    const next={version:1 as const,servers:[...previous.filter(server=>!oldIds.has(server.id)),...providers]};
    await this.manager.updateConfig(next);
    try{await atomicJson(this.lockPath(proposal.scope),{version:1,entries});}
    catch(error){await this.manager.updateConfig(config);throw error;}
   }else await atomicJson(this.lockPath(proposal.scope),{version:1,entries});
   for(const removed of current.entries.filter(entry=>!entries.some(next=>next.key===entry.key&&next.digest===entry.digest))){
    await fs.rm(this.contentDirectory(removed.scope,removed.digest,removed.component.id,removed.component.kind),{recursive:true,force:true});
    await fs.rm(path.join(this.scopeRoot(removed.scope),"packages",removed.digest,removed.component.id),{recursive:true,force:true});
   }
   await fs.rename(path.join(this.root,"proposals",id+".json"),path.join(this.root,"proposals",id+".used.json"));
   return {version:1,entries};
  });
 }
}
