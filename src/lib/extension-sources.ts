import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
import {extractZip} from "./safe-zip.js";
import {gunzipSync} from "node:zlib";
import {downloadHttps,safeFetch,validateNetworkUrl} from "./safe-network.js";
import {normalizeConfig,parseMcpServersFile,type UpstreamServerConfig} from "./mcp-upstream-config.js";

const exec=promisify(execFile);
export const sha256=(bytes:string|Buffer):string=>createHash("sha256").update(bytes).digest("hex");
export type ComponentKind="mcp"|"skill"|"instructions"|"pack";
export interface ExtensionComponent {
  id:string;kind:ComponentKind;name:string;description:string;
  files:Record<string,string>;provider?:UpstreamServerConfig;
  requirements:string[];permissions:string[];
  members?:string[];
  package?:{type:"npm"|"pypi";name:string;version:string;url:string;integrity:string;sha256?:string;entrypoint?:string;dependencies?:string[];filename?:string};
}
export interface Discovery {source:string;adapter:string;resolved:string;digest:string;components:ExtensionComponent[];warnings:string[];}
export interface SourceAdapter {
  id:string;
  detect(source:string):boolean;
  discover(source:string):Promise<Omit<Discovery,"source"|"adapter"|"digest">>;
}
export function safeRelative(input:string):string {
  if(!input || input.length>240 || input.includes("\\") || input.includes("\0") || input.startsWith("/") || /^[a-z]:/i.test(input) || input.split("/").some(x=>x===".."||x===""||x==="."||x==="__proto__"))throw new Error("SOURCE_PATH_UNSAFE: "+input);
  return input;
}
export function componentId(input:string):string {
  const value=input.toLowerCase().replace(/[^a-z0-9_-]/g,"-").slice(0,48);
  if(!/^[a-z0-9][a-z0-9_-]*$/.test(value))throw new Error("Invalid component identifier");
  return value;
}
function cleanMarkdown(text:string):string {
  if(Buffer.byteLength(text)>131072 || /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(text))throw new Error("MARKDOWN_UNSAFE_OR_TOO_LARGE");
  return text;
}
export function validateSkill(text:string,files:Record<string,string>,skillPath="SKILL.md"):{name:string;description:string} {
  cleanMarkdown(text);
  const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const name=front?.[1].match(/^name:\s*([a-z0-9][a-z0-9-]{0,63})\s*$/m)?.[1];
  const description=front?.[1].match(/^description:\s*([^\r\n]{1,500})\s*$/m)?.[1];
  if(!name || !description)throw new Error("SKILL_METADATA_INVALID: plain name and description required");
  for(const link of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)){
    const target=link[1];
    if(target.split("/").includes(".."))throw new Error("SOURCE_PATH_UNSAFE: skill references must stay within the skill directory");
    if(target.startsWith("#"))continue;
    if(/^https:\/\//.test(target)){const url=new URL(target);if(url.username||url.password)throw new Error("SKILL_LINK_UNSAFE");continue;}
    if(/^[a-z]+:/i.test(target))throw new Error("SKILL_LINK_UNSAFE");
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(skillPath),target.split("#")[0]));
    safeRelative(resolved);
    if(!(resolved in files))throw new Error("SKILL_REFERENCE_MISSING: "+resolved);
  }
  return {name,description};
}
export function discoverFiles(files:Record<string,string>):ExtensionComponent[]{
  const out:ExtensionComponent[]=[];
  for(const [filename,raw] of Object.entries(files)){
    safeRelative(filename);
    if(filename.endsWith("/SKILL.md") || filename==="SKILL.md"){
      const info=validateSkill(raw,files,filename),directory=path.posix.dirname(filename);
      const selected=Object.fromEntries(Object.entries(files).filter(([file])=>directory==="."||file.startsWith(directory+"/")).map(([file,value])=>[directory==="."?file:file.slice(directory.length+1),value]));
      out.push({id:componentId(info.name),kind:"skill",...info,files:selected,requirements:[],permissions:["Untrusted guidance only; never executed"]});
    }
    if(["bridge-dev.json",".bridge-dev/pack.json"].includes(filename)){
      const manifest=JSON.parse(raw);
      if(manifest.version!==1)throw new Error("Unsupported extension manifest version");
      if(manifest.servers){
        const config=normalizeConfig({version:1,servers:manifest.servers});
        for(const server of config.servers)out.push({id:server.id,kind:"mcp",name:server.name,description:"Reviewed provider definition",files:{},provider:{...server,enabled:false,expose:"none"},requirements:manifest.requirements || [server.transport==="stdio"?server.command!:"Reachable HTTP endpoint"],permissions:["Provider execution requires separate enable and tool approval"]});
      }
      const members:string[]=[];
      if(manifest.instructions){
        if(!Array.isArray(manifest.instructions)||manifest.instructions.length>32)throw new Error("PACK_INSTRUCTIONS_INVALID");
        for(const instruction of manifest.instructions){
          safeRelative(instruction);if(!/\.md$/i.test(instruction)||!files[instruction])throw new Error("PACK_INSTRUCTION_MISSING");
          const id=componentId(path.posix.basename(instruction,".md"));members.push("instructions:"+id);
          out.push({id,kind:"instructions",name:id,description:"Pack Markdown instructions",files:{[path.posix.basename(instruction)]:cleanMarkdown(files[instruction])},requirements:[],permissions:["Untrusted guidance; never executed"]});
        }
      }
      if(manifest.skills){
        if(!Array.isArray(manifest.skills)||manifest.skills.length>64)throw new Error("PACK_SKILLS_INVALID");
        for(const skill of manifest.skills){safeRelative(skill);const file=skill.endsWith("SKILL.md")?skill:skill+"/SKILL.md";if(!files[file])throw new Error("PACK_SKILL_MISSING");const info=validateSkill(files[file],files,file);members.push("skill:"+componentId(info.name));}
      }
      for(const server of manifest.servers||[])members.push("mcp:"+server.id);
      if(manifest.pack){out.push({id:componentId(manifest.pack.name),kind:"pack",name:manifest.pack.name,description:String(manifest.pack.description||"Extension pack"),files:{[filename]:raw},members,requirements:manifest.requirements||[],permissions:["Review each member; executable providers remain disabled"]});}
    }
    if((filename==="mcp.json"||filename===".mcp.json") || (/\.json$/i.test(filename) && !filename.endsWith("bridge-dev.json") && !filename.endsWith("pack.json") && raw.includes('"mcpServers"'))){
      const rawConfig=JSON.parse(raw);
      const servers=rawConfig.mcpServers?parseMcpServersFile(rawConfig):normalizeConfig(rawConfig).servers;
      for(const server of servers)out.push({id:server.id,kind:"mcp",name:server.name,description:"Imported MCP definition",files:{},provider:{...server,enabled:false,expose:"none"},requirements:[server.command || "HTTP endpoint"],permissions:["Execution and exposure denied until operator review"]});
    }
  }
  if(!out.length && Object.keys(files).length===1){
    const [filename,text]=Object.entries(files)[0];
    if(/\.md$/i.test(filename))out.push({id:componentId(path.posix.basename(filename,".md")),kind:"instructions",name:path.posix.basename(filename),description:"Untrusted Markdown instructions",files:{[path.posix.basename(filename)]:cleanMarkdown(text)},requirements:[],permissions:["Guidance only; never executed"]});
  }
  return out;
}
async function localFiles(root:string):Promise<Record<string,string>>{
  const files:Record<string,string>={};let count=0,total=0;
  async function walk(dir:string,depth:number):Promise<void>{
    if(depth>8)throw new Error("SOURCE_DEPTH_LIMIT");
    for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if([".git","node_modules",".venv","dist",".ssh",".gnupg",".aws",".kube"].includes(entry.name)||/^\.env(?:$|\.(?!example$))/.test(entry.name)||/\.(pem|key)$/.test(entry.name))continue;
      if(++count>512)throw new Error("SOURCE_FILE_COUNT_LIMIT");
      const name=path.join(dir,entry.name),rel=path.relative(root,name).split(path.sep).join("/");safeRelative(rel);
      if(entry.isSymbolicLink())throw new Error("SOURCE_SYMLINK_REFUSED: "+rel);
      if(entry.isDirectory())await walk(name,depth+1);
      else if(entry.isFile()){
        const st=await fs.stat(name);if(st.size>1048576 || (total+=st.size)>8*1048576)throw new Error("SOURCE_SIZE_LIMIT");
        files[rel]=await fs.readFile(name,"utf8");
      }else throw new Error("SOURCE_SPECIAL_FILE_REFUSED");
    }
  }
  await walk(root,0);return files;
}
async function gitCommand(args:string[],cwd:string):Promise<string>{
  const result=await exec("git",["-c","core.hooksPath="+path.join(cwd,"no-hooks"),"-c","credential.helper=","-c","protocol.allow=never","-c","protocol.http.allow=always","-c","http.followRedirects=false",...args],{cwd,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOME:cwd,USERPROFILE:cwd,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:path.join(cwd,"no-config"),GIT_TERMINAL_PROMPT:"0"},timeout:30000,maxBuffer:8*1048576});
  return result.stdout;
}
/** An on-demand bounded smart-HTTP relay keeps Git DNS/redirects under the same
 * source policy. No checkout, hooks, submodules, credential helpers or filters. */
async function remoteGit(source:string):Promise<{files:Record<string,string>;resolved:string}>{
  const parsed=new URL(source.replace(/^git\+/,""));const ref=parsed.hash.slice(1);parsed.hash="";
  if(ref && !/^[a-zA-Z0-9_./-]{1,128}$/.test(ref))throw new Error("GIT_REF_INVALID");
  await validateNetworkUrl(parsed.href);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"bridge-source-git-"));let total=0;
  const relay=http.createServer(async(req,res)=>{try{
    if(!req.url?.startsWith("/repo.git"))throw new Error("Invalid Git request");
    const chunks:Buffer[]=[];let input=0;
    for await(const chunk of req){input+=chunk.length;if(input>1048576)throw new Error("Git request limit");chunks.push(chunk);}
    const suffix=req.url.slice("/repo.git".length);
    const remote=parsed.href.replace(/\/$/,"")+suffix;
    const result=await safeFetch(false,16*1048576)(remote,{method:req.method,headers:{"content-type":String(req.headers["content-type"]||"application/x-git-upload-pack-request")},signal:AbortSignal.timeout(20000),...(chunks.length?{body:Buffer.concat(chunks) as any}:{})});
    const bytes=Buffer.from(await result.arrayBuffer());total+=bytes.length;if(total>32*1048576)throw new Error("Git download limit");
    res.writeHead(result.status,{"content-type":result.headers.get("content-type")||"application/octet-stream"});res.end(bytes);
  }catch{res.writeHead(502);res.end("SOURCE_GIT_FETCH_REFUSED");}});
  try{
    await new Promise<void>(resolve=>relay.listen(0,"127.0.0.1",resolve));
    const address=relay.address();if(!address||typeof address==="string")throw new Error("Git relay unavailable");
    await gitCommand(["clone","--bare","--depth=1",...(ref?["--branch",ref]:[]),"--",`http://127.0.0.1:${address.port}/repo.git`,"repo"],root);
    const gitDir=path.join(root,"repo"),resolved=(await gitCommand(["--git-dir",gitDir,"rev-parse","HEAD"],root)).trim();
    const tree=await gitCommand(["--git-dir",gitDir,"ls-tree","-rzl",resolved],root);
    const files:Record<string,string>={};let count=0,bytes=0;
    for(const entry of tree.split("\0").filter(Boolean)){
      if(++count>512)throw new Error("SOURCE_FILE_COUNT_LIMIT");
      const match=entry.match(/^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/s);
      if(!match || !["100644","100755"].includes(match[1]))throw new Error("SOURCE_GIT_SPECIAL_FILE_REFUSED");
      const [,mode,object,size,file]=match;safeRelative(file);
      if(Number(size)>1048576 || (bytes+=Number(size))>8*1048576)throw new Error("SOURCE_SIZE_LIMIT");
      files[file]=await gitCommand(["--git-dir",gitDir,"cat-file","blob",object],root);
    }
    return {files,resolved};
  }finally{relay.closeAllConnections();await new Promise<void>(resolve=>relay.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
}
export function extractTar(bytes:Buffer):Record<string,Buffer>{
  if(bytes[0]===0x1f&&bytes[1]===0x8b)bytes=gunzipSync(bytes,{maxOutputLength:16*1048576});
  if(bytes.length>16*1048576)throw new Error("ARCHIVE_SIZE_LIMIT");
  const out:Record<string,Buffer>={};let count=0;
  for(let offset=0;offset+512<=bytes.length;){
    const header=bytes.subarray(offset,offset+512);if(header.every(x=>x===0))break;
    const read=(a:number,b:number)=>header.subarray(a,b).toString().replace(/\0.*$/s,"");
    const expected=parseInt(read(148,156).trim(),8);let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];if(checksum!==expected)throw new Error("ARCHIVE_CHECKSUM_INVALID");
    const filename=[read(345,500),read(0,100)].filter(Boolean).join("/").replace(/\/$/,"");safeRelative(filename);
    const size=parseInt(read(124,136).trim()||"0",8),type=read(156,157);
    if(!Number.isSafeInteger(size)||size<0||offset+512+size>bytes.length||size>1048576||++count>512)throw new Error("ARCHIVE_LIMIT");
    if(type!=="0"&&type!==""&&type!=="5")throw new Error("ARCHIVE_LINK_OR_SPECIAL_REFUSED");
    if(type!=="5"){if(filename in out)throw new Error("ARCHIVE_DUPLICATE");out[filename]=bytes.subarray(offset+512,offset+512+size);}
    offset+=512+Math.ceil(size/512)*512;
  }
  if(!count)throw new Error("ARCHIVE_INVALID");return out;
}
class LocalAdapter implements SourceAdapter{
 id="local";detect(source:string):boolean{return !/^[a-z][a-z0-9+.-]*:/i.test(source)||path.isAbsolute(source);}
 async discover(source:string){
   const root=path.resolve(source),stat=await fs.lstat(root);if(stat.isSymbolicLink())throw new Error("SOURCE_SYMLINK_REFUSED");
   let files:Record<string,string>;
   if(stat.isDirectory())files=await localFiles(root);
   else{if(stat.size>1048576)throw new Error("SOURCE_SIZE_LIMIT");files={[path.basename(root)]:await fs.readFile(root,"utf8")};}
   let resolved=sha256(JSON.stringify(files));
   if(stat.isDirectory()){try{const result=await exec("git",["-C",root,"rev-parse","HEAD"],{timeout:3000});resolved=result.stdout.trim();}catch{}}
   return {resolved,components:discoverFiles(files),warnings:[]};
 }
}
class GitAdapter implements SourceAdapter{
 id="git";detect(s:string):boolean{return /^git\+https:\/\//.test(s)||/^https:\/\/[^/]+\/.*\.git(?:#.*)?$/.test(s)||/^https:\/\/(github\.com|gitlab\.com)\/[^/]+\/[^/#]+\/?(?:#.*)?$/.test(s);}
 async discover(source:string){const result=await remoteGit(source);return {resolved:result.resolved,components:discoverFiles(result.files),warnings:[]};}
}
class UrlAdapter implements SourceAdapter{
 id="https";detect(s:string):boolean{return /^https?:\/\//.test(s);}
 async discover(source:string){
  let url=new URL(source);
  if(url.hostname==="github.com" && /^\/[^/]+\/[^/]+\/blob\//.test(url.pathname)){url=new URL("https://raw.githubusercontent.com/"+url.pathname.slice(1).replace("/blob/","/"));source=url.href;}
  if(url.hostname==="gitlab.com" && url.pathname.includes("/-/blob/")){url.pathname=url.pathname.replace("/-/blob/","/-/raw/");source=url.href;}
  if(url.protocol!=="https:")throw new Error("SOURCE_HTTPS_REQUIRED: register a local/private MCP endpoint explicitly instead");
  const name=decodeURIComponent(url.pathname.split("/").pop()||"");
  if(/\.(md|json)$/i.test(name)){
   const bytes=await downloadHttps(source);const files={[name]:bytes.toString("utf8")};return {resolved:sha256(bytes),components:discoverFiles(files),warnings:[]};
  }
  if(/\.(tgz|tar|tar.gz)$/i.test(name)){
   const bytes=await downloadHttps(source,8*1048576),archive=extractTar(bytes);const files=Object.fromEntries(Object.entries(archive).map(([k,v])=>[k.replace(/^[^/]+\//,""),v.toString("utf8")]));
   return {resolved:sha256(bytes),components:discoverFiles(files),warnings:[]};
  }
  if(/\.zip$/i.test(name)){
   const bytes=await downloadHttps(source,8*1048576),archive=extractZip(bytes);
   const names=Object.keys(archive),prefix=names.every(k=>k.includes("/")&&k.split("/")[0]===names[0].split("/")[0])?names[0].split("/")[0]+"/":"";
   const files=Object.fromEntries(Object.entries(archive).map(([k,v])=>[k.slice(prefix.length),v.toString("utf8")]));
   return {resolved:sha256(bytes),components:discoverFiles(files),warnings:[]};
  }
  await validateNetworkUrl(source);
  const id=componentId(url.hostname);
  return {resolved:sha256(source),components:[{id,kind:"mcp" as const,name:id,description:"HTTP endpoint registration; protocol verification requires operator approval",files:{},provider:{id,name:id,enabled:false,transport:"http" as const,url:source,expose:"none" as const,auth:{type:"none" as const}},requirements:["Running compatible MCP HTTP endpoint"],permissions:["HTTP connection and tool allowlist require separate approval"]}],warnings:["Endpoint not contacted or assumed to be an MCP server until tested"]};
 }
}
class PackageAdapter implements SourceAdapter{
 id="package";detect(s:string):boolean{return /^(npm|pypi):/.test(s);}
 async discover(source:string){
  const match=source.match(/^(npm|pypi):(@[^/]+\/[^@]+|[^@]+)(?:@([^/]+))?$/);if(!match)throw new Error("PACKAGE_SOURCE_INVALID");
  const [,type,name,requested]=match;if(!/^[@a-zA-Z0-9/_.-]+$/.test(name))throw new Error("PACKAGE_NAME_INVALID");
  const url=type==="npm"?`https://registry.npmjs.org/${encodeURIComponent(name)}`:`https://pypi.org/pypi/${encodeURIComponent(name)}/${requested?encodeURIComponent(requested)+"/":""}json`;
  const metadata=JSON.parse((await downloadHttps(url)).toString());
  const version=type==="npm"?(requested||metadata["dist-tags"]?.latest):metadata.info?.version;
  const info=type==="npm"?metadata.versions?.[version]:metadata.info;
  if(!info || typeof version!=="string")throw new Error("PACKAGE_VERSION_NOT_FOUND");
  const artifact=type==="npm"?{url:info.dist?.tarball,integrity:info.dist?.integrity}:metadata.urls?.find((item:any)=>item.packagetype==="bdist_wheel" && /-py3-none-any\.whl$/.test(item.filename||item.url));
  if(!artifact?.url)throw new Error("PACKAGE_NO_REVIEWABLE_ARTIFACT: Python requires a universal py3-none-any wheel");
  const bins=type==="npm"?(typeof info.bin==="string"?{[name.split("/").pop()!]:info.bin}:info.bin||{}):{};
  const components:ExtensionComponent[]=Object.keys(bins).map(bin=>({id:componentId(bin),kind:"mcp",name:bin,description:String(info.description||"Package executable"),files:{},requirements:[type==="npm"?"Node.js and reviewed dependency installation":"Python and wheel-compatible runtime"],permissions:["Package installation and execution require exact-version approval; hooks disabled"],package:{type:type as "npm",name,version,url:artifact.url,integrity:artifact.integrity||artifact.digests?.sha256||""}}));
  if(type==="pypi")components.push({id:componentId(name),kind:"mcp",name,description:String(info.summary||name),files:{},requirements:["Python; review wheel entrypoints and all dependencies"],permissions:["No builds or source distributions executed"],package:{type:"pypi",name,version,url:artifact.url,integrity:artifact.digests?.sha256||""}});
  const bytes=await downloadHttps(artifact.url,8*1048576);
  const archive=type==="npm"?extractTar(bytes):extractZip(bytes);
  if(type==="npm"){
    const pkg=JSON.parse(archive["package/package.json"]?.toString()||"{}");
    if(pkg.name!==name || pkg.version!==version)throw new Error("PACKAGE_METADATA_MISMATCH");
    for(const [field,current]of [["os",process.platform],["cpu",process.arch]] as const){const allowed=pkg[field];if(Array.isArray(allowed)&&(allowed.includes("!"+current)||allowed.some((item:string)=>!item.startsWith("!"))&&!allowed.includes(current)))throw new Error("PACKAGE_PLATFORM_UNSUPPORTED: "+field+" "+current);}
    for(const component of components){
      const entrypoint=String(bins[component.name]);safeRelative(entrypoint.replace(/^\.\//,""));
      if(!archive["package/"+entrypoint.replace(/^\.\//,"")])throw new Error("PACKAGE_ENTRYPOINT_MISSING");
      if(!/\.(?:c?js|mjs)$/.test(entrypoint)&&!/^#![^\n]*\bnode\b/.test(archive["package/"+entrypoint.replace(/^\.\//,"")].toString("utf8")))throw new Error("NPM_ENTRYPOINT_REVIEW_REQUIRED: only Node.js entrypoints install automatically");
      Object.assign(component.package!,{sha256:sha256(bytes),entrypoint,dependencies:Object.keys(pkg.dependencies||{})});
    }
  }else{
    const entry=Object.entries(archive).find(([name])=>name.endsWith(".dist-info/entry_points.txt"));
    const lines=entry?.[1].toString().match(/\[console_scripts\]\s*([\s\S]*?)(?:\n\[|$)/)?.[1]||"";
    const bins=[...lines.matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*([a-zA-Z0-9_.]+:[a-zA-Z0-9_.]+)\s*$/gm)];
    if(!bins.length)throw new Error("PYPI_ENTRYPOINT_REVIEW_REQUIRED: no console_scripts entrypoints");
    components.splice(0,components.length,...bins.map(([,bin,target])=>({...components[0],id:componentId(bin),name:bin,package:{...components[0].package!,entrypoint:target,sha256:sha256(bytes),filename:artifact.filename||new URL(artifact.url).pathname.split("/").pop(),dependencies:info.requires_dist||[]}})));
  }
  return {resolved:version,components,warnings:["Package metadata does not prove MCP compatibility. Only dependency-free packages install automatically; dependency graphs require independent review and installation. No install hooks or Python builds run."]};
 }
}
export class SourceCatalog{
 constructor(private adapters:SourceAdapter[]=[new LocalAdapter(),new GitAdapter(),new PackageAdapter(),new UrlAdapter()]){}
 async discover(source:string):Promise<Discovery>{
  if(source.length>2048 || /[\x00-\x20]/.test(source)&&!path.isAbsolute(source)&&!source.startsWith("."))throw new Error("SOURCE_INVALID");
  const adapter=this.adapters.find(item=>item.detect(source));if(!adapter)throw new Error("SOURCE_UNSUPPORTED: HTTPS Git, HTTPS files/endpoints, npm:, pypi: or local paths required");
  const result=await adapter.discover(source);
  if(!result.components.length)throw new Error("SOURCE_AMBIGUOUS: no reliable MCP manifest, SKILL.md, standalone Markdown or pack; provide bridge-dev.json or a compatible mcp.json. README commands are never executed.");
  const seen=new Set<string>();for(const component of result.components){const key=component.kind+":"+component.id;if(seen.has(key))throw new Error("SOURCE_COMPONENT_COLLISION: "+key);seen.add(key);}
  return {source,adapter:adapter.id,...result,digest:sha256(JSON.stringify(result))};
 }
 async updateInfo(locked:Pick<Discovery,"source"|"digest">){const current=await this.discover(locked.source);return {changed:locked.digest!==current.digest,current};}
}
