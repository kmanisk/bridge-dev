#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fixturePorts} from "./test-ports.mjs";
import { spawn,spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-dev-portable-server-"));
const workspace=path.join(root,"workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace,"AGENTS.md"),"# Test workspace\nOnly inspect local fixtures.\n");
const token=randomBytes(32).toString("hex");
const adminToken=randomBytes(32).toString("hex");
let child,logs="";
try{
  const [port,adminPort]=await fixturePorts(2);
  if(port===adminPort)throw new Error("Port collision");
  const env={...process.env,HOST:"127.0.0.1",PORT:String(port),ADMIN_PORT:String(adminPort),
    MCP_TOKEN:token,ADMIN_TOKEN:adminToken,
    WORKSPACE_PATH:workspace,BRIDGEDEV_RUNTIME_MODE:"portable",
    BRIDGEDEV_STATE_DIR:path.join(root,"state"),CHATGPT_TOOL_PROFILE:"slim"};
  delete env.POLICYGATE_POLICY_FILE;
  delete env.MCP_UPSTREAM_CONFIG;
  for(const bad of ["too-short","REPLACE_WITH_64_HEX_CHAR_RANDOM_TOKEN","x".repeat(40)+"*"]){
    const rejected=spawnSync(process.execPath,["dist/index.js"],{cwd:process.cwd(),env:{...env,MCP_TOKEN:bad},encoding:"utf8",timeout:5000});
    assert.equal(rejected.status,1);assert.ok(!rejected.stderr.includes(bad));
  }
  child=spawn(process.execPath,["dist/index.js"],{cwd:process.cwd(),env,stdio:["ignore","pipe","pipe"]});
  child.stdout?.on("data",b=>{logs=(logs+b.toString()).slice(-12000);});
  child.stderr?.on("data",b=>{logs=(logs+b.toString()).slice(-12000);});
  let health;
  const start=Date.now();
  while(Date.now()-start<18000){
    if(child.exitCode!==null)throw new Error("Server exited "+child.exitCode+"; "+logs);
    try {
        const response=await fetch("http://127.0.0.1:"+port+"/health",{signal:AbortSignal.timeout(1500)});
      if(response.ok){health=await response.json();break;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,175));
  }
  if(!health)throw new Error("Portable server health timeout. "+logs);
  assert.equal(health.status,"ok");
  assert.equal(health.runtimeMode,"portable");
  assert.equal(health.platform.runtime,"portable");
  assert.equal(health.workspace,workspace);
  assert.equal(health.fullMachineAccess,false);
  assert.equal(health.activeSessions,0);
  assert.ok(!logs.includes(token),"Server must not log MCP token");
  const bad=await fetch("http://127.0.0.1:"+port+"/mcp");
  assert.equal(bad.status,401,"Tokenless MCP endpoint should not be reachable");
  const admin=await fetch("http://127.0.0.1:"+adminPort+"/health");
  assert.equal(admin.status,401,"Admin API must require token");
  const bearer=await fetch("http://127.0.0.1:"+port+"/mcp",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:10,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"bearer-ci",version:"1"}}})});
  assert.equal(bearer.status,200);
  await bearer.text();
  const response=await fetch("http://127.0.0.1:"+port+"/mcp/"+token,{
    method:"POST",
    headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{
      protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"portable-ci",version:"1.0.0"}}}),
    signal:AbortSignal.timeout(7000),
  });
  const body=await response.text();
  assert.equal(response.status,200,"MCP init: "+response.status+" "+body.slice(0,600)+" "+logs);
  assert.match(body,/bridge-dev|serverInfo/i,"MCP response must identify BridgeDev");
  console.log("BridgeDev portable server: startup, health, admin isolation, token routing and MCP initialization PASS");
} finally {
  if(child && child.exitCode===null){
    child.kill();
    await Promise.race([
      new Promise(resolve=>child.once("exit",resolve)),
      new Promise(resolve=>setTimeout(resolve,2500)),
    ]);
    if(child.exitCode===null)child.kill("SIGKILL");
  }
  fs.rmSync(root,{recursive:true,force:true});
}
