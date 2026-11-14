import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
export function readCases(plan,provider){
 const repo=plan.repo,file=path.join(repo,'visible.txt');
 return {system_context:{docs:['agents','current_state']},system_inspect:{sections:['resources']},chezmoi_inspect:{path:file},read_text_file:{path:file},read_file_base64:{path:file},list_directory:{path:repo},glob:{path:repo,pattern:'*.txt'},grep:{path:repo,pattern:'fixture'},search_files:{path:repo,pattern:'fixture'},directory_tree:{path:repo,max_depth:1},list_allowed_directories:{},git_status:{path:repo},git_diff:{path:repo},git_log:{path:repo,count:1},git_branch:{path:repo,action:'list'},git_stash:{path:repo,action:'list'},shell_status:{},process_status:{},process_output:{id:'acceptance-unconfigured-process'},system_job:{action:'list'},rewind:{action:'list'},list_skills:{},load_skill:{name:plan.skillName},project_context:{path:repo,max_depth:0},agent_status:{},load_path_rules:{path:file},mcp_servers:{refresh:false},mcp_tools:{server_id:provider},mcp_info:{name:provider},mcp_list:{},mcp_status:{},skills_validate:{},extensions_list:{},extensions_info:{},extensions_search:{query:'acceptance'},skills_list:{},skills_info:{}};
}
export async function acceptGateway({url,adminUrl,mcpToken,adminToken,fixtures,inventory,baseline=false}){
 const clients=[],checks={},reads={},validator=new AjvJsonSchemaValidator();let tools=[];
 async function connect(){const c=new Client({name:'independent-deploy-acceptance',version:'1'},{capabilities:{}}),t=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+mcpToken}}});await c.connect(t);clients.push({c,t});await c.listTools();return c;}
 async function call(c,name,args={}){
  const tool=tools.find(t=>t.name===name);if(tool)assert(validator.getValidator(tool.inputSchema)(args).valid,'ACCEPTANCE_INVALID_ARGUMENTS: '+name);
  const r=await c.callTool({name,arguments:args});CallToolResultSchema.parse(r);
  if(!baseline||name!=='skills_validate')assert(!/Output validation error|Invalid structured content|does not conform to output schema/i.test(JSON.stringify(r)),'ACCEPTANCE_OUTPUT_SCHEMA: '+name);
  if(r.structuredContent&&tool?.outputSchema)assert(validator.getValidator(tool.outputSchema)(r.structuredContent).valid,'ACCEPTANCE_OUTPUT_SCHEMA: '+name);
  else assert(r.isError===true||!tool?.outputSchema,'ACCEPTANCE_MISSING_STRUCTURED_CONTENT: '+name);
  return r;
 }
 const get=(endpoint,headers)=>fetch(endpoint,{headers,signal:AbortSignal.timeout(5000)});
 try{
  const health=await(await get(new URL('/health',url))).json();assert(health.status==='ok'&&health.fullMachineAccess===false,'ACCEPTANCE_HEALTH_OR_MODE');checks.health_standard=true;
  assert((await get(url)).status===401,'ACCEPTANCE_UNAUTHENTICATED_MCP');checks.mcp_authentication=true;
  const first=await connect();tools=(await first.listTools()).tools;checks.initialize=true;
  assert(tools.length===inventory.length&&inventory.every(name=>tools.some(t=>t.name===name)),'ACCEPTANCE_TOOL_INVENTORY');checks.tool_discovery=true;
  assert(/POLICYGATE_CONTEXT_REQUIRED/.test(JSON.stringify(await call(first,'run_command',{command:'pwd'}))),'ACCEPTANCE_BEFORE_CONTEXT');checks.before_context_denied=true;
  const context=await call(first,'system_context',{docs:['agents','current_state']});assert(context.structuredContent?.ok&&!context.isError,'ACCEPTANCE_CONTEXT');checks.system_context=true;
  const pwd=await call(first,'run_command',{command:'pwd'});
  const pwdFailure=JSON.stringify(pwd).match(/POLICYGATE_[A-Z_]+/)?.[0]||'UNKNOWN';
  assert(pwd.structuredContent?.ok&&pwd.structuredContent.data.exit_code===0,'ACCEPTANCE_PWD: '+pwdFailure);
  checks.pwd=true;
  for(const command of ['sudo -n id','rm -rf /']){const r=await call(first,'run_command',{command});assert(r.isError&&/POLICYGATE_(APPROVAL_REQUIRED|COMMAND_DENIED|STRICT_NO_SUDO)/.test(JSON.stringify(r)),'ACCEPTANCE_PRIVILEGE_DENIAL');}checks.privileged_destructive_denied=true;
  const second=await connect();assert(/POLICYGATE_CONTEXT_REQUIRED/.test(JSON.stringify(await call(second,'run_command',{command:'pwd'}))),'ACCEPTANCE_SESSION_ISOLATION');checks.second_client_denied=true;
  if(!baseline){
   const proof=context.structuredContent.data.context_token;assert(typeof proof==='string','ACCEPTANCE_CONTEXT_CAPABILITY');
   async function raw(args){const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+mcpToken,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'run_command',arguments:args}}),signal:AbortSignal.timeout(15000)});assert(r.ok,'ACCEPTANCE_STATELESS_HTTP');const sid=r.headers.get('mcp-session-id');try{return(await r.json()).result;}finally{if(sid)await fetch(url,{method:'DELETE',headers:{Authorization:'Bearer '+mcpToken,'Mcp-Session-Id':sid},signal:AbortSignal.timeout(5000)});}}
   assert((await raw({command:'pwd',context_token:proof})).structuredContent?.ok,'ACCEPTANCE_STATELESS_CAPABILITY');assert(/POLICYGATE_CONTEXT_REQUIRED/.test(JSON.stringify(await raw({command:'pwd'}))),'ACCEPTANCE_STATELESS_ISOLATION');checks.stateless_context_and_isolation=true;
  }
  const listed=await call(first,'mcp_list'),registry=listed.structuredContent?.data;assert(listed.structuredContent?.ok&&!registry.initialization_error&&registry.configuration?.source_schema==='v1','ACCEPTANCE_REGISTRY');checks.mcp_list=true;
  const provider=registry.providers[0]?.id||'acceptance-unconfigured-provider';
  if(!baseline){
   assert(fixtures,'ACCEPTANCE_FIXTURES_REQUIRED');const cases=readCases(fixtures,provider);
   for(const tool of tools){
    if(tool.name.includes('_propose_'))continue;
    const args=cases[tool.name];
    // Read-only annotations and known read variants must have explicit cases.
    if(args===undefined){assert(tool.annotations?.readOnlyHint!==true,'ACCEPTANCE_READ_CASE_MISSING: '+tool.name);continue;}
    const r=await call(first,tool.name,args);
    if(!r.structuredContent){
     const missing=tool.name==='process_output'||(!registry.providers.length&&['mcp_info','mcp_tools'].includes(tool.name));
     const pattern=tool.name==='mcp_info'?/PROVIDER_NOT_FOUND/:tool.name==='mcp_tools'?/Unknown server_id/:/Unknown process|not found/i;
     assert(missing&&r.isError&&pattern.test(JSON.stringify(r)),'ACCEPTANCE_READ_FAILED: '+tool.name);
    }
    reads[tool.name]=r.isError?'schema-valid expected missing resource':'schema-valid structured result';
   }
   assert(reads.load_skill==='schema-valid structured result'&&reads.skills_validate==='schema-valid structured result','ACCEPTANCE_SKILL_READS');checks.all_read_output_schemas=true;
  }else{
   const known=await call(first,'skills_validate');assert(known.isError&&/expected record, received array at data/.test(JSON.stringify(known)),'ACCEPTANCE_BASELINE_BUG_CHANGED');checks.baseline_known_schema_bug=true;
  }
  const info=await call(first,'mcp_info',{name:provider});assert(registry.providers.length?info.structuredContent?.ok:info.isError&&/PROVIDER_NOT_FOUND/.test(JSON.stringify(info)),'ACCEPTANCE_MCP_INFO');checks.mcp_info=true;
  const status=await call(first,'mcp_status');assert(status.structuredContent?.ok&&!status.structuredContent.data.initialization_error,'ACCEPTANCE_MCP_STATUS');checks.mcp_status=true;
  const admin=await get(new URL('/api/extensions',adminUrl),{Authorization:'Bearer '+adminToken});assert(admin.ok,'ACCEPTANCE_ADMIN_AUTH');const data=await admin.json();assert(!data.data.registry_error&&data.data.configuration.source_schema==='v1','ACCEPTANCE_ADMIN_REGISTRY');checks.admin_authenticated=true;
  for(const credential of ['',mcpToken])assert((await get(new URL('/api/extensions',adminUrl),credential?{Authorization:'Bearer '+credential}:{})).status===401,'ACCEPTANCE_ADMIN_ISOLATION');checks.admin_auth_isolation=true;
  assert((await get(new URL('/ui/',adminUrl))).ok,'ACCEPTANCE_ADMIN_UI');checks.admin_ui=true;
  return {ok:true,checks,reads,read_tools:Object.keys(reads).length,tool_count:tools.length,configured_providers:registry.providers.length,chatgpt_acceptance:'not tested'};
 }catch(error){error.acceptance={ok:false,error:error.message,checks,reads};throw error;}
 finally{for(const{c,t}of clients){await t.terminateSession().catch(()=>{});await c.close().catch(()=>{});}}
}
