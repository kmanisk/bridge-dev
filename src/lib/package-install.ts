import fs from "node:fs/promises";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
import {downloadHttps} from "./safe-network.js";
import {extractTar,safeRelative,sha256,type ExtensionComponent} from "./extension-sources.js";
import type {UpstreamServerConfig} from "./mcp-upstream-config.js";
const exec=promisify(execFile);
export async function installReviewedPackage(component:ExtensionComponent,root:string):Promise<UpstreamServerConfig>{
 const pkg=component.package!;
 if(pkg.dependencies?.length)throw new Error("PACKAGE_DEPENDENCIES_REQUIRE_REVIEW: "+pkg.dependencies.join(", ")+"; import an independently installed local executable definition");
 const bytes=await downloadHttps(pkg.url,8*1048576);
 if(!pkg.sha256 || sha256(bytes)!==pkg.sha256)throw new Error("PACKAGE_HASH_CHANGED_REAPPROVAL_REQUIRED");
 if(pkg.type==="npm"){
  const [algorithm,expected]=pkg.integrity.split("-");
  if(!["sha256","sha384","sha512"].includes(algorithm)||createHash(algorithm).update(bytes).digest("base64")!==expected)throw new Error("PACKAGE_INTEGRITY_INVALID");
  const archive=extractTar(bytes);
  await fs.mkdir(root,{recursive:true,mode:0o700});
  for(const [name,data]of Object.entries(archive)){
   if(!name.startsWith("package/"))throw new Error("PACKAGE_ARCHIVE_ROOT_INVALID");
   const rel=safeRelative(name.slice(8)),target=path.join(root,rel);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,data,{mode:0o600});
  }
  return {id:component.id,name:component.name,enabled:false,transport:"stdio",command:process.execPath,args:[path.join(root,pkg.entrypoint!.replace(/^\.\//,""))],expose:"none",env:{}};
 }
 if(pkg.integrity!==sha256(bytes))throw new Error("PACKAGE_INTEGRITY_INVALID");
 const filename=pkg.filename!;if(!/^[a-zA-Z0-9_.+-]+\.whl$/.test(filename))throw new Error("WHEEL_FILENAME_INVALID");
 await fs.mkdir(root,{recursive:true,mode:0o700});const wheel=path.join(root,filename);await fs.writeFile(wheel,bytes,{mode:0o600});
 const python=process.platform==="win32"?"python":"python3",venv=path.join(root,"venv");
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOME:root,USERPROFILE:root,PIP_CONFIG_FILE:process.platform==="win32"?"NUL":"/dev/null",PIP_NO_INDEX:"1",PIP_DISABLE_PIP_VERSION_CHECK:"1"};
 await exec(python,["-m","venv",venv],{env,timeout:30000,maxBuffer:65536});
 const executable=path.join(venv,process.platform==="win32"?"Scripts/python.exe":"bin/python");
 await exec(executable,["-m","pip","install","--no-index","--no-deps","--only-binary=:all:",wheel],{env,timeout:30000,maxBuffer:65536});
 const [module,fn]=pkg.entrypoint!.split(":");if(!/^[a-zA-Z0-9_.]+$/.test(module)||!/^[a-zA-Z0-9_]+$/.test(fn))throw new Error("WHEEL_ENTRYPOINT_UNSUPPORTED");
 return {id:component.id,name:component.name,enabled:false,transport:"stdio",command:executable,args:["-c",`from ${module} import ${fn}; ${fn}()`],env:{},expose:"none"};
}
