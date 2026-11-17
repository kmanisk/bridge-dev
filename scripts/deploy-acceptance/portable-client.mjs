// Independent portable acceptance. Does not impose managed-only context/registry
// requirements, issue approvals, change modes, or alter provider configuration.
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import {createFixtures,preflightFixtures,cleanupFixtures} from './fixtures.mjs';
import {readCases} from './client.mjs';
import {verifyGatewayToolInventory} from './tool-inventory.mjs';
export async function acceptPortableGateway({url,adminUrl,mcpToken,adminToken,workspace,inventory}){
 const clients=[],checks={},reads={},validator=new AjvJsonSchemaValidator();let fixtures,tools;
 const get=(endpoint,headers)=>fetch(endpoint,{headers,signal:AbortSignal.timeout(5000)});
 async function connect(){const c=new Client({name:'independent-portable-acceptance',version:'1'},{capabilities:{}}),t=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+mcpToken}}});await c.connect(t);clients.push({c,t});return c;}
 async function call(c,name,args={}){
  const tool=tools.find(t=>t.name===name);assert.ok(tool,'Missing acceptance tool: '+name);assert.ok(validator.getValidator(tool.inputSchema)(args).valid,'Invalid acceptance arguments: '+name);
  const r=await c.callTool({name,arguments:args});assert.doesNotMatch(JSON.stringify(r),/Output validation error|Invalid structured content|does not conform to output schema/i);
  if(r.structuredContent&&tool.outputSchema)assert.ok(validator.getValidator(tool.outputSchema)(r.structuredContent).valid,'Output schema mismatch: '+name);
  else assert.ok(r.isError||!tool.outputSchema,'Missing structured result: '+name);return r;
 }
 try{
  const health=await(await get(new URL('/health',url),{Authorization:'Bearer '+mcpToken})).json();assert.equal(health.runtimeMode,'portable');assert.equal(health.fullMachineAccess,false);assert.equal(health.workspace,workspace);checks.health_standard=true;
  assert.equal((await get(url)).status,401);checks.mcp_authentication=true;
  const first=await connect();tools=(await first.listTools()).tools;
  // Native tools remain an exact mandatory set. Approved optional MCP proxies
  // may add tools to this user's gateway, so check them separately against the
  // authenticated operator-reviewed upstream allowlist rather than rejecting
  // the legitimate 52-native + 3-REA case with a 55 !== 52 count mismatch.
  const providerResponse=await get(new URL('/api/upstream',adminUrl),{Authorization:'Bearer '+adminToken});
  assert.ok(providerResponse.ok,'ACCEPTANCE_UPSTREAM_CONFIG_AUTH');
  const providerConfig=await providerResponse.json();
  assert.ok(providerConfig.ok===true&&Array.isArray(providerConfig.config?.servers),
    'ACCEPTANCE_UPSTREAM_CONFIG_INVALID');
  const inventoryCheck=verifyGatewayToolInventory(tools,inventory,providerConfig.config.servers);
  // All exposed proxy schemas must be locally compilable; do not invoke
  // optional servers or require their idle on-demand processes to remain up.
  for(const tool of tools.filter(t=>!inventory.includes(t.name)))
    assert.ok(validator.getValidator(tool.inputSchema),'ACCEPTANCE_OPTIONAL_INPUT_SCHEMA: '+tool.name);
  checks.initialize_and_inventory=true;
  checks.reviewed_provider_inventory=true;
  const context=await call(first,'system_context',{docs:['agents','current_state']});assert.ok(context.structuredContent?.ok);checks.system_context=true;
  for(const command of ['pwd','git --version','node --version','id -u','echo bridge-dev-qa']){const r=await call(first,'run_command',{command});if(process.env.SHADOW_CI_DEBUG==='1'&&!r.structuredContent?.ok)console.error("CI_SHADOW_RUN_COMMAND "+command+": "+JSON.stringify(r.structuredContent||r).slice(0,550));assert.ok(r.structuredContent?.ok,'Diagnostic failed: '+command);assert.equal(r.structuredContent.data.exit_code,0);}checks.diagnostics=true;
  for(const command of ['sudo -n id','rm -rf /']){const r=await call(first,'run_command',{command});assert.ok(r.isError);assert.match(JSON.stringify(r),/POLICYGATE_(APPROVAL_REQUIRED|COMMAND_DENIED)/);}checks.privilege_and_destructive_denied=true;
  const second=await connect();const status=await call(second,'agent_status');assert.equal(status.structuredContent.data.full_machine_access,false);const denied=await call(second,'run_command',{command:'sudo -n id'});assert.match(JSON.stringify(denied),/POLICYGATE_APPROVAL_REQUIRED/);checks.second_client_no_root=true;
  const listed=await call(first,'mcp_list'),registry=listed.structuredContent?.data;assert.ok(listed.structuredContent?.ok&&!registry.initialization_error);assert.ok(['v1','legacy-unversioned','missing'].includes(registry.configuration.source_schema));checks.registry=true;
  // Fixtures are introduced after startup and removed before returning, so the
  // startup instruction snapshot cannot retain temporary skills.
  fixtures=createFixtures(workspace);preflightFixtures(fixtures);
  const cases=readCases(fixtures,registry.providers[0]?.id||'acceptance-unconfigured-provider');
  for(const tool of tools.filter(t=>inventory.includes(t.name))){const args=cases[tool.name];if(args===undefined){assert.notEqual(tool.annotations?.readOnlyHint,true,'Missing read case: '+tool.name);continue;}
   const r=await call(first,tool.name,args);
   if(r.isError){const pattern=tool.name==='mcp_info'?/PROVIDER_NOT_FOUND/:tool.name==='mcp_tools'?/Unknown server_id/:tool.name==='process_output'?/Unknown process/:null;assert.ok(pattern,'Read tool failed: '+tool.name);assert.match(JSON.stringify(r),pattern);}
   else assert.ok(r.structuredContent?.ok,'Read tool not successful: '+tool.name);
   reads[tool.name]=r.isError?'expected missing resource; schema-valid':'schema-valid';
  }
  assert.equal(reads.load_skill,'schema-valid');assert.equal(reads.skills_validate,'schema-valid');checks.all_read_schemas=true;
  const headers={Authorization:'Bearer '+adminToken};const admin=await get(new URL('/health',adminUrl),headers);assert.ok(admin.ok);assert.ok(!('mcp_token' in await admin.json()));
  for(const credential of ['',mcpToken])assert.equal((await get(new URL('/api/extensions',adminUrl),credential?{Authorization:'Bearer '+credential}:{})).status,401);
  assert.ok((await get(new URL('/ui/',adminUrl))).ok);checks.admin_authentication_and_isolation=true;
  return {ok:true,checks,reads,tool_count:tools.length,native_tool_count:inventoryCheck.native,reviewed_optional_tool_count:inventoryCheck.optional,read_tools:Object.keys(reads).length,configured_providers:registry.providers.length,context_requirement:'not configured in portable mode; managed enforcement tested separately',chatgpt_acceptance:'not tested'};
 }finally{for(const{c,t}of clients){await t.terminateSession().catch(()=>{});await c.close().catch(()=>{});}if(fixtures)cleanupFixtures(fixtures);}
}
