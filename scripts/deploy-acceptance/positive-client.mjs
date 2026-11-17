// Positive-only smoke check for a live gateway with an existing YOLO lease.
// Never invoke denial fixtures, privileged commands, writes or provider tools.
import assert from "node:assert/strict";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {AjvJsonSchemaValidator} from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import {verifyGatewayToolInventory} from "./tool-inventory.mjs";

export async function positiveGatewaySmoke({url,adminUrl,mcpToken,adminToken,inventory,expectedFullMachineAccess}){
  const headers={Authorization:"Bearer "+mcpToken};
  const get=(path,init={})=>fetch(new URL(path,url),{...init,signal:AbortSignal.timeout(4000)});
  const healthy=await get("/health",{headers});
  assert.ok(healthy.ok,"UPDATE_SMOKE_AUTH_HEALTH");
  const health=await healthy.json();
  assert.equal(health.fullMachineAccess,expectedFullMachineAccess,"UPDATE_SMOKE_MODE_CHANGED");
  assert.equal((await get("/mcp")).status,401,"UPDATE_SMOKE_MCP_ANONYMOUS_ALLOWED");
  const adminResponse=await fetch(new URL("/api/upstream",adminUrl),{
    headers:{Authorization:"Bearer "+adminToken},signal:AbortSignal.timeout(4000)});
  assert.ok(adminResponse.ok,"UPDATE_SMOKE_ADMIN_AUTH");
  const config=await adminResponse.json();
  assert.ok(config.ok&&Array.isArray(config.config?.servers));
  const client=new Client({name:"verified-update-positive-smoke",version:"1.0.0"},{capabilities:{}});
  const transport=new StreamableHTTPClientTransport(new URL("/mcp",url),{requestInit:{headers}});
  try{
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    const observed=verifyGatewayToolInventory(tools,inventory,config.config.servers);
    const validator=new AjvJsonSchemaValidator();
    let read=0;
    for(const tool of tools){
      assert.ok(validator.getValidator(tool.inputSchema),"UPDATE_SMOKE_INVALID_INPUT_SCHEMA: "+tool.name);
      if(tool.outputSchema)assert.ok(validator.getValidator(tool.outputSchema),
        "UPDATE_SMOKE_INVALID_OUTPUT_SCHEMA: "+tool.name);
      if(tool.annotations?.readOnlyHint)read++;
    }
    const agent=tools.find(tool=>tool.name==="agent_status");
    assert.ok(agent,"UPDATE_SMOKE_AGENT_STATUS_MISSING");
    const response=await client.callTool({name:"agent_status",arguments:{}});
    assert.ok(!response.isError&&response.structuredContent?.ok,"UPDATE_SMOKE_STATUS_READ_FAILED");
    assert.equal(response.structuredContent.data.full_machine_access,
      expectedFullMachineAccess,"UPDATE_SMOKE_STATUS_MODE_CHANGED");
    return {ok:true,authenticated:true,read_only_invoked:1,
      tools:tools.length,native:observed.native,optional:observed.optional,
      schemas_validated:tools.length,read_tools:read};
  }finally{
    await transport.terminateSession().catch(()=>{});
    await client.close().catch(()=>{});
  }
}
