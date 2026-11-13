#!/usr/bin/env node
// Ephemeral, unprivileged first-run trial. Never installs or modifies services.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const flags=new Set(process.argv.slice(2));
if(flags.has("--help")){
  console.log("Usage: node scripts/try-local.mjs [--show-secrets]");
  console.log("Runs an isolated, localhost-only trial. Type quit or press Ctrl-C to stop.");
  process.exit(0);
}
if([...flags].some(x=>x!=="--show-secrets")){
  console.error("Unknown option. Use --help.");
  process.exit(2);
}
if(process.getuid?.()===0){
  console.error("Refusing to run as root. Test BridgeDev with an unprivileged account.");
  process.exit(1);
}
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
if(!fs.existsSync(path.join(repo,"dist","index.js"))){
  console.error("Build first: pnpm install --frozen-lockfile --ignore-scripts && pnpm run build");
  process.exit(1);
}
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-dev-trial-"));
if(process.platform!=="win32")fs.chmodSync(scratch,0o700);
const workspace=path.join(scratch,"project");
fs.mkdirSync(workspace,{recursive:true});
fs.writeFileSync(path.join(workspace,"README.md"),"# BridgeDev trial\nThis disposable project is safe to edit.\n");
fs.writeFileSync(path.join(workspace,"AGENTS.md"),"# Trial instructions\nWork only in the temporary project. Never access other directories.\n");
fs.writeFileSync(path.join(scratch,"empty.env"),"");
fs.writeFileSync(path.join(scratch,"mcp.json"),JSON.stringify({version:1,servers:[]}));
const getFreePort=()=>new Promise((resolve,reject)=>{
  const server=net.createServer();
  server.on("error",reject);
  server.listen(0,"127.0.0.1",()=>{
    const address=server.address();
    if(!address||typeof address==="string")return reject(new Error("Cannot select an IPv4 port"));
    server.close(()=>resolve(address.port));
  });
});
let child;
let stopRequested=false;
let forcedKill;
let lastOutput="";
const scrub=(text)=>text.split(mcpToken).join("[REDACTED_MCP_TOKEN]").split(adminToken).join("[REDACTED_ADMIN_TOKEN]");
const mcpToken=randomBytes(32).toString("hex");
const adminToken=randomBytes(32).toString("hex");

function requestStop(){
  if(stopRequested)return;
  stopRequested=true;
  // A piped stdin stream remains referenced even when paused; destroy it on quit.
  process.stdin.pause();
  process.stdin.destroy();
  if(child && child.exitCode===null && !child.signalCode){
    child.kill("SIGTERM");
    forcedKill=setTimeout(()=>{
      if(child && child.exitCode===null && !child.signalCode)child.kill("SIGKILL");
    },3000);
    forcedKill.unref();
  }
}
process.on("SIGINT",requestStop);
process.on("SIGTERM",requestStop);
process.stdin.setEncoding("utf8");
process.stdin.on("data",data=>{
  if(data.trim().toLowerCase()==="quit")requestStop();
});

try {
  const port=await getFreePort();
  let adminPort=await getFreePort();
  while(adminPort===port)adminPort=await getFreePort();
  const env={...process.env};
  for(const key of Object.keys(env)){
    if(/^(POLICYGATE_|LOCAL_CODER_|MCP_|BRIDGEDEV_|WORKSPACE_|EXTRA_WORKSPACE_|ALLOWED_WORKSPACE_|CHATGPT_|GIT_CONFIG_|NODE_OPTIONS$|NODE_PATH$|ADMIN_TOKEN$|PORT$|ADMIN_PORT$|HOST$|AUDIT_LOG_PATH$|POST_EDIT_HOOKS_CONFIG$|CHECKPOINT_)/.test(key))delete env[key];
  }
  Object.assign(env,{
    HOME:scratch,USERPROFILE:scratch,
    XDG_CONFIG_HOME:path.join(scratch,"config"),
    XDG_DATA_HOME:path.join(scratch,"data"),
    XDG_STATE_HOME:path.join(scratch,"state"),
    XDG_CACHE_HOME:path.join(scratch,"cache"),
    LOCALAPPDATA:path.join(scratch,"appdata"),
    APPDATA:path.join(scratch,"appdata"),
    DOTENV_CONFIG_PATH:path.join(scratch,"empty.env"),
    HOST:"127.0.0.1",PORT:String(port),ADMIN_PORT:String(adminPort),
    MCP_TOKEN:mcpToken,ADMIN_TOKEN:adminToken,
    WORKSPACE_PATH:workspace,BRIDGEDEV_STATE_DIR:path.join(scratch,"gateway-state"),
    BRIDGEDEV_RUNTIME_MODE:"portable",CHATGPT_TOOL_PROFILE:"slim",
    MCP_UPSTREAM_CONFIG:path.join(scratch,"mcp.json"),
    MCP_OAUTH_STORE:path.join(scratch,"oauth"),
    MCP_SHELL_STATE_DIR:path.join(scratch,"shell"),
    CHECKPOINT_ENABLED:"false",
    GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:path.join(scratch,"gitconfig"),
  });
  child=spawn(process.execPath,[path.join(repo,"dist","index.js")],{
    cwd:repo,env,stdio:["ignore","pipe","pipe"],
  });
  child.stdout?.on("data",chunk=>{lastOutput=(lastOutput+chunk.toString()).slice(-18000);});
  child.stderr?.on("data",chunk=>{lastOutput=(lastOutput+chunk.toString()).slice(-18000);});
  const exited=new Promise((resolve,reject)=>{
    child.once("error",reject);
    child.once("exit",(code,signal)=>resolve({code,signal}));
  });
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    if(child.exitCode!==null||child.signalCode)break;
    if(stopRequested)break;
    try {
      const response=await fetch("http://127.0.0.1:"+port+"/health",{
        signal:AbortSignal.timeout(800),
      });
      if(response.ok){
        const data=await response.json();
        if(data.runtimeMode==="portable"&&data.fullMachineAccess===false){
          ready=true;break;
        }
      }
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  if(!ready){
    requestStop();
    throw new Error("Trial gateway failed to start: "+scrub(lastOutput).slice(-2000));
  }

  console.log("BridgeDev isolated trial — running");
  console.log("Workspace     : "+workspace);
  console.log("MCP endpoint  : http://127.0.0.1:"+port+"/mcp/<MCP_TOKEN>");
  console.log("Admin UI      : http://127.0.0.1:"+adminPort+"/ui/");
  console.log("Health        : http://127.0.0.1:"+port+"/health");
  if(flags.has("--show-secrets")){
    console.log("Private MCP URL   : http://127.0.0.1:"+port+"/mcp/"+mcpToken);
    console.log("Private admin token: "+adminToken);
    console.log("Keep these test credentials in your private terminal; do not share.");
  } else {
    console.log("Credentials hidden. Restart with --show-secrets for local client/admin login.");
  }
  console.log("No production service, tunnel, package or host configuration was changed.");
  console.log("This is NOT an OS sandbox; do not run untrusted tools or commands.");
  console.log("Type quit or press Ctrl-C to stop and delete the trial workspace.");
  const result=await exited;
  if(!stopRequested&&result.code!==0){
    throw new Error("Trial gateway exited unexpectedly ("+result.code+"): "+scrub(lastOutput).slice(-2000));
  }
} catch(error) {
  console.error("BridgeDev trial: "+(error instanceof Error?error.message:String(error)));
  process.exitCode=1;
} finally {
  requestStop();
  if(child&&child.exitCode===null&&!child.signalCode){
    await Promise.race([
      new Promise(resolve=>child.once("exit",resolve)),
      new Promise(resolve=>setTimeout(resolve,3500)),
    ]);
  }
  if(forcedKill)clearTimeout(forcedKill);
  process.stdin.pause();
  process.stdin.destroy();
  fs.rmSync(scratch,{recursive:true,force:true});
}
