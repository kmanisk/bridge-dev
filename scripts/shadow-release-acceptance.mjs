// Runs only inside the launcher's disposable, mount- and network-isolated
// bubblewrap namespace. Never run against the live service.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {spawn,spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {acceptPortableGateway} from "./deploy-acceptance/portable-client.mjs";

const root="/shadow", release="/release";
function absent(p){
  try{const fd=fs.openSync(p,"r");fs.closeSync(fd);throw Error("SHADOW_PRODUCTION_PATH_READABLE: "+p);}
  catch(error){if(error?.message?.startsWith("SHADOW_PRODUCTION_PATH_READABLE"))throw error;
    if(!["ENOENT","EACCES","EPERM","ENOTDIR"].includes(error?.code))throw error;}
}
const hostHome=process.env.BRIDGEDEV_SHADOW_HOST_HOME||"/nonexistent-host-home";
assert.ok(path.isAbsolute(hostHome),"SHADOW_HOST_HOME_INVALID");
const blocked=[
  path.join(hostHome,".config/bridge-dev/.env"),
  path.join(hostHome,".ssh/id_ed25519"),
  path.join(hostHome,".gnupg/private-keys-v1.d"),
  "/var/lib/bridge-dev-operator/active-lease.json",
  "/var/lib/local-coder-policygate/yolo-lease.json",
  "/var/lib/bridge-dev/yolo-lease.json",
  "/etc/bridge-dev/operator-public.pem",
  "/usr/local/bin/bridge-dev-controller",
];
let gateway;
try{
  if(process.env.BRIDGEDEV_SHADOW_SANDBOX!=="v1"||!fs.existsSync(release+"/DEPLOYED_COMMIT"))
    throw Error("SHADOW_ISOLATION_UNVERIFIED");
  for(const p of blocked)absent(p);
  // The namespace has no host routes. Loopback must be functional for
  // the gateway + SDK client; enable only the *private* lo interface if needed.
  const loopback=async()=>{
    const server=net.createServer();
    try{
      const port=await new Promise((resolve,reject)=>{
        server.once("error",reject);
        server.listen(0,"127.0.0.1",()=>resolve(server.address().port));
      });
      return await new Promise(resolve=>{
        const client=net.createConnection({port,host:"127.0.0.1"});
        let done=false;
        const finish=(ok)=>{if(done)return;done=true;client.destroy();resolve(ok);};
        client.once("connect",()=>finish(true));
        client.once("error",()=>finish(false));
        client.setTimeout(400,()=>finish(false));
      });
    }catch{return false;}
    finally{if(server.listening)await new Promise(r=>server.close(r));}
  };
  if(!await loopback()){
    const lo=spawnSync("/usr/bin/ip",["link","set","lo","up"],{encoding:"utf8",timeout:3000});
    if(lo.status!==0||!await loopback())throw Error("SHADOW_LOOPBACK_UNAVAILABLE");
  }
  const prodPort=Number(process.env.BRIDGEDEV_SHADOW_PRODUCTION_PORT||3000);
  assert.ok(Number.isSafeInteger(prodPort)&&prodPort>0&&prodPort<=65535);
  const probe=net.createConnection({host:"127.0.0.1",port:prodPort});
  const exposed=await new Promise(resolve=>{
    let done=false;
    const finish=(x)=>{if(done)return;done=true;probe.destroy();resolve(x);};
    probe.once("connect",()=>finish(true));
    probe.once("error",()=>finish(false));
    probe.setTimeout(450,()=>finish(false));
  });
  if(exposed)throw Error("SHADOW_PRODUCTION_NETWORK_REACHABLE");
  const pick=()=>new Promise((resolve,reject)=>{
    const server=net.createServer();
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const port=server.address().port;server.close(()=>resolve(port));
    });
  });
  const port=await pick(),adminPort=await pick();
  if(port===adminPort||port===prodPort||adminPort===prodPort)throw Error("SHADOW_PORT_COLLISION");
  const workspace=path.join(root,"workspace");
  await fsp.mkdir(workspace,{recursive:true,mode:0o700});
  const providers=path.join(root,"providers.json");
  await fsp.writeFile(providers,JSON.stringify({version:1,servers:[]}),{mode:0o600});
  const mcpToken=randomBytes(32).toString("hex"),adminToken=randomBytes(32).toString("hex");
  const env={
    PATH:"/usr/local/bin:/usr/bin:/bin",HOME:root,XDG_CONFIG_HOME:path.join(root,"config"),
    XDG_DATA_HOME:path.join(root,"data"),XDG_STATE_HOME:path.join(root,"state"),
    BRIDGEDEV_RUNTIME_MODE:"portable",BRIDGEDEV_TEST_ROOT:root,
    BRIDGEDEV_STATE_DIR:path.join(root,"state"),WORKSPACE_PATH:workspace,
    MCP_UPSTREAM_CONFIG:providers,MCP_SHELL_STATE_DIR:path.join(root,"shell"),
    CHECKPOINT_ENABLED:"false",HOST:"127.0.0.1",
    PORT:String(port),ADMIN_PORT:String(adminPort),MCP_TOKEN:mcpToken,
    ADMIN_TOKEN:adminToken,CHATGPT_TOOL_PROFILE:"slim",
  };
  gateway=spawn("/opt/shadow-node",[path.join(release,"dist/index.js")],
    {cwd:root,env,stdio:"ignore"});
  let ready=false;
  for(let i=0;i<160;i++){
    if(gateway.exitCode!==null)throw Error("SHADOW_GATEWAY_EXITED");
    try{
      const res=await fetch("http://127.0.0.1:"+port+"/healthz",
        {signal:AbortSignal.timeout(400)});
      if(res.ok){ready=true;break;}
    }catch{}
    await new Promise(r=>setTimeout(r,70));
  }
  if(!ready)throw Error("SHADOW_GATEWAY_NOT_READY");
  const inventory=JSON.parse(await fsp.readFile(release+"/profiles/native-tool-counts.json","utf8")).tools.slim;
  const receipt=await acceptPortableGateway({
    url:"http://127.0.0.1:"+port+"/mcp",
    adminUrl:"http://127.0.0.1:"+adminPort,
    mcpToken,adminToken,workspace,inventory
  });
  assert.ok(receipt.ok&&receipt.checks.privilege_and_destructive_denied&&
    receipt.checks.second_client_no_root&&receipt.checks.admin_authentication_and_isolation,
    "SHADOW_NEGATIVE_ACCEPTANCE_FAILED");
  console.log(JSON.stringify({ok:true,checks:receipt.checks,
    native:receipt.native_tool_count,read_tools:receipt.read_tools,
    production_secrets_inaccessible:true,production_network_isolated:true}));
}catch(error){
  if(process.env.SHADOW_CI_DEBUG==="1"){
    for(const [name,args] of [["git",["--version"]],["sh",["-c","git --version"]],["node",["--version"]]]){
      const check=spawnSync(name,args,{encoding:"utf8",timeout:2000});
      console.error("CI_SHADOW_COMMAND "+name+": status="+check.status+
        " error="+(check.error?.code||"none")+" output="+
        String(check.stdout||check.stderr||"").slice(0,120).replace(/\n/g," "));
    }
  }
  console.error("SHADOW_FAILED: "+String(error instanceof Error?error.message:error).slice(0,170));
  process.exitCode=1;
}finally{
  if(gateway&&gateway.exitCode===null){
    gateway.kill("SIGTERM");
    await Promise.race([new Promise(r=>gateway.once("exit",r)),new Promise(r=>setTimeout(r,1500))]);
    if(gateway.exitCode===null)gateway.kill("SIGKILL");
  }
}