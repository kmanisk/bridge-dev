#!/usr/bin/env node
// Cross-platform, disposable trial launcher acceptance. No production credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
const runner=spawn(process.execPath,["scripts/try-local.mjs","--show-secrets"],{
  cwd:process.cwd(),stdio:["pipe","pipe","pipe"],env:{...process.env},
});
let stdout="",stderr="";
runner.stdout.on("data",chunk=>{stdout=(stdout+chunk.toString()).slice(-24000);});
runner.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-24000);});
const exited=new Promise((resolve,reject)=>{
  runner.once("error",reject);
  runner.once("exit",(code,signal)=>resolve({code,signal}));
});
try {
  let mcp,admin,workspace;
  for(let i=0;i<110;i++){
    mcp=stdout.match(/Private MCP URL\s*:\s*(http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]{64})/)?.[1];
    admin=stdout.match(/Private admin token:\s*([a-f0-9]{64})/)?.[1];
    workspace=stdout.match(/Workspace\s*:\s*(.+)/)?.[1]?.trim();
    if(mcp&&admin&&workspace)break;
    if(runner.exitCode!==null)throw new Error("Trial exited early: "+stderr);
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(mcp&&admin&&workspace,"Trial did not print local-only credentials: "+stderr);
  assert.ok(fs.existsSync(workspace),"Workspace fixture must exist while trial runs");
  const base=mcp.replace(/\/mcp\/[^/]+$/,"");
  const health=await (await fetch(base+"/health")).json();
  assert.equal(health.runtimeMode,"portable");
  assert.equal(health.fullMachineAccess,false);
  const anonymous=await fetch(base+"/mcp");
  assert.equal(anonymous.status,401);
  const response=await fetch(mcp,{
    method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{
      protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"trial-ci",version:"1.0.0"}
    }}),signal:AbortSignal.timeout(7000),
  });
  assert.equal(response.status,200,"MCP init returned "+response.status);
  const payload=await response.text();
  assert.match(payload,/bridge-dev|serverInfo/i);
  runner.stdin.write("quit\n");
  const result=await Promise.race([
    exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Trial did not stop")),8500))
  ]);
  assert.equal(result.code,0,"Trial shutdown must return success: "+stderr);
  assert.equal(fs.existsSync(path.dirname(workspace)),false,"Trial temporary directory must be removed");
  console.log("BridgeDev isolated trial: health, auth, MCP initialization, graceful cleanup PASS");
} finally {
  if(runner.exitCode===null&&!runner.signalCode)runner.kill("SIGTERM");
}
