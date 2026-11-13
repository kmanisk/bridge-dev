import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
const root=path.resolve(fileURLToPath(new URL("..",import.meta.url)));
const req=createRequire(path.join(root,"package.json"));
const {Client}=await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const {InMemoryTransport}=await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/inMemory.js")).href);
const {createMcpServer}=await import(pathToFileURL(path.join(root,"dist/server-factory.js")).href);
const {newPolicySession}=await import(pathToFileURL(path.join(root,"dist/lib/policy-gateway.js")).href);
const {initUpstreamManager}=await import(pathToFileURL(path.join(root,"dist/lib/mcp-upstream-manager.js")).href);
const base=await fsp.mkdtemp(path.join(os.tmpdir(),"pg-upstream-redteam-"));
const work=path.join(base,"work"),src=path.join(base,"docs");
const helper=path.join(base,"startup-helper.sh"),marker=path.join(base,"MCP_UPSTREAM_EXECUTED");
let client,server;
try {
 await fsp.mkdir(work);await fsp.mkdir(path.join(src,"docs/system"),{recursive:true});
 await fsp.writeFile(path.join(src,"AGENTS.md"),"fixture rules\n");
 await fsp.writeFile(path.join(src,"docs/system/SYSTEM_CONTEXT.md"),"fixture context\n");
 await fsp.writeFile(helper,"#!/bin/sh\nprintf 'MARKED\\n' > '"+marker+"'\nexit 1\n",{mode:0o755});
 const cfg=JSON.parse(await fsp.readFile(path.join(root,"profiles/policy.example.json"),"utf8"));
 Object.assign(cfg,{context_files:[path.join(src,"AGENTS.md"),path.join(src,"docs/system/SYSTEM_CONTEXT.md")],writable_roots:[work],protected_paths:[],secret_paths:[],approval_paths:[],hard_paths:[],audit_log:path.join(base,"audit.jsonl")});
 const config=path.join(base,"policy.json");
 await fsp.writeFile(config,JSON.stringify(cfg));
 const upstreamConfig=path.join(base,"upstream.json");
 await fsp.writeFile(upstreamConfig,JSON.stringify({version:1,servers:[{id:"untrusted",name:"Untrusted Stdio",enabled:true,transport:"stdio",command:helper,args:[],env:{},expose:"meta_only"}]}));
 Object.assign(process.env,{POLICYGATE_POLICY_FILE:config,MCP_UPSTREAM_CONFIG:upstreamConfig,
 LOCAL_CODER_CHEZMOI_SOURCE_DIR:src,CHATGPT_TOOL_PROFILE:"full",WORKSPACE_PATH:work,
 CHECKPOINT_ENABLED:"false",MCP_UPSTREAM_CONNECT_TIMEOUT_MS:"1000"});
 const manager=await initUpstreamManager();
 server=createMcpServer(work,12,[work],false,manager,undefined,newPolicySession());
 client=new Client({name:"read-before-context-redteam",version:"1"},{capabilities:{}});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const report={};
 for(const [name,args] of [["mcp_servers",{}],["mcp_tools",{server_id:"untrusted"}],["agent_status",{}]]) {
   await fsp.rm(marker,{force:true});
   const result=await client.callTool({name,arguments:args});
   report[name]={tool_error:!!result.isError,executed_stdio_helper_before_context:fs.existsSync(marker)};
 }
 await fsp.rm(marker,{force:true});
 const refreshed=await client.callTool({name:"mcp_servers",arguments:{refresh:true}});
 assert.equal(Boolean(refreshed.isError || refreshed.structuredContent?.ok===false),true,
   "Explicit upstream refresh must require context/approval");
 assert.match(JSON.stringify(refreshed),/POLICYGATE_CONTEXT_REQUIRED/);
 assert.equal(fs.existsSync(marker),false,"Refresh executed helper before context");
 console.log(JSON.stringify({read_only_tools:report,refresh_denied_before_context:true},null,2));
 for(const result of Object.values(report)) {
  assert.equal(result.executed_stdio_helper_before_context,false,
    "Read-only discovery started untrusted stdio provider");
 }
}finally{
 if(client)await client.close().catch(()=>{});
 if(server)await server.close().catch(()=>{});
 await fsp.rm(base,{recursive:true,force:true});
}
