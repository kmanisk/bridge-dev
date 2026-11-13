// Explicit root-side production check, never included in isolated test runners.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const [mode,release,envFile]=process.argv.slice(2);
if(mode!=='accept'||process.getuid?.()!==0)throw Error('Independent root deployment acceptance only');
const require=createRequire(path.join(release,'package.json'));
const environment=require('dotenv').parse(fs.readFileSync(envFile));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const port=Number(environment.PORT||3000),adminPort=Number(environment.ADMIN_PORT||3001),url=`http://127.0.0.1:${port}/mcp`;
const checks={},clients=[];
function check(ok,message){if(!ok)throw Error(message);}
function controller(action,input,args=[]){const result=spawnSync('/usr/local/bin/bridge-dev-controller',[action,...args],{env:{PATH:'/usr/bin:/bin'},input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',timeout:30000});check(result.status===0,'Controller '+action+' failed');return JSON.parse(result.stdout);}
async function connect(){const client=new Client({name:'independent-production-acceptance',version:'2'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+environment.MCP_TOKEN}}}));clients.push(client);return client;}
const call=(client,name,args={})=>client.callTool({name,arguments:args});
const denied=result=>result.isError||result.structuredContent?.ok===false;
try{
 const first=await connect();checks.initialize=true;
 const tools=(await first.listTools()).tools,inventory=JSON.parse(fs.readFileSync(path.join(release,'profiles/native-tool-counts.json')));
 check(inventory.tools.slim.every(name=>tools.some(tool=>tool.name===name)),'Missing slim-profile tool');checks.slim_52_tools=true;
 check(/POLICYGATE_CONTEXT_REQUIRED/.test(JSON.stringify(await call(first,'run_command',{command:'pwd'}))),'Uninitialized execution was not denied');checks.before_context_denied=true;
 const context=await call(first,'system_context',{docs:['agents','current_state']});check(context.structuredContent?.ok,'Context load failed');checks.system_context=true;
 check((await call(first,'run_command',{command:'pwd'})).structuredContent?.ok,'Context then pwd failed');checks.pwd=true;
 const proof=context.structuredContent.data.context_token;check(typeof proof==='string','Explicit context token missing');
 const raw=async(name,args)=>{const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+environment.MCP_TOKEN,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(30000)});check(response.ok,'Stateless MCP HTTP failed');return (await response.json()).result;};
 check((await raw('run_command',{command:'pwd',context_token:proof})).structuredContent?.ok,'Stateless explicit context failed');checks.stateless_context_token=true;
 const second=await connect();check(/POLICYGATE_CONTEXT_REQUIRED/.test(JSON.stringify(await call(second,'run_command',{command:'pwd'}))),'Second client inherited authorization');checks.second_client_denied=true;
 const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();
 if(health.fullMachineAccess){
  const command='test "$(id -u)" = 0 && test "$(readlink /proc/self/ns/mnt)" = "$(readlink /proc/1/ns/mnt)" && sudo -n /usr/bin/id -u && bridge_qa_dir=$(mktemp -d /var/lib/bridge-dev-controller/qa.XXXXXX) && printf host-root > "$bridge_qa_dir/file" && test "$(stat -c %u "$bridge_qa_dir/file")" = 0 && cat "$bridge_qa_dir/file" && rm -rf -- "$bridge_qa_dir"';
  const root=await call(first,'run_command',{command,working_directory:'/'});
  check(root.structuredContent?.ok&&/0\nhost-root/.test(root.structuredContent.data.stdout),'Host-root namespace/multi-command test failed');checks.full_host_root_sudo=true;
  const sleeper=controller('submit',{kind:'exec',request_id:randomUUID(),argv:['/bin/bash','-c','sleep 60 & wait'],cwd:'/',timeout:120});
  controller('revoke');
  const config=JSON.parse(fs.readFileSync('/etc/local-coder-policygate/controller.json'));
  // End the independently issued lease. No new signature is created or extended.
  fs.rmSync(config.lease,{force:true});
  check(controller('status',undefined,[sleeper.job_id]).status==='REVOKED','Tracked job survived revocation');checks.tracked_job_revocation=true;
  const refused=spawnSync('/usr/local/bin/bridge-dev-controller',['submit'],{env:{PATH:'/usr/bin:/bin'},input:JSON.stringify({kind:'exec',request_id:randomUUID(),argv:['/usr/bin/id','-u'],cwd:'/',timeout:1}),encoding:'utf8',timeout:10000});check(refused.status!==0,'Root execution survived revocation');checks.root_revoked=true;
 }
 for(const command of ['sudo -n id','rm -rf /'])check(denied(await call(first,'run_command',{command})),'Unapproved command was not denied');checks.standard_restrictions=true;
 check((await call(first,'run_command',{command:'pwd'})).structuredContent?.ok,'STANDARD pwd failed after revocation');checks.standard_pwd=true;
 const listed=await call(first,'mcp_list'),data=listed.structuredContent?.data;
 check(listed.structuredContent?.ok&&!data.initialization_error&&data.configuration?.source_schema==='v1','Registry schema error');checks.mcp_list=true;
 const providers=data.providers;check(Array.isArray(providers),'Provider list is invalid');
 const info=await call(first,'mcp_info',{name:providers[0]?.id||'acceptance-unconfigured-provider'});
 check(providers.length?info.structuredContent?.ok:/PROVIDER_NOT_FOUND/.test(JSON.stringify(info)),'mcp_info failed');checks.mcp_info=true;
 const status=await call(first,'mcp_status');check(status.structuredContent?.ok&&!status.structuredContent.data.initialization_error,'MCP status failed');checks.mcp_status=true;
 const admin=await fetch(`http://127.0.0.1:${adminPort}/api/extensions`,{headers:{Authorization:'Bearer '+environment.ADMIN_TOKEN},signal:AbortSignal.timeout(5000)});check(admin.ok,'Authenticated admin failed');check(!(await admin.json()).data?.registry_error,'Admin registry error');checks.admin_authenticated=true;
 check((await fetch(`http://127.0.0.1:${adminPort}/api/extensions`,{headers:{Authorization:'Bearer '+environment.MCP_TOKEN},signal:AbortSignal.timeout(5000)})).status===401,'MCP token accepted by admin');checks.admin_auth_isolation=true;
 const config=JSON.parse(fs.readFileSync(environment.POLICYGATE_POLICY_FILE));const {verifyAuditFile}=await import(pathToFileURL(path.join(release,'dist/lib/hash-audit.js')));const audit=verifyAuditFile(config.audit_log);check(audit.entries>0,'Audit missing');checks.audit_integrity=true;
 console.log(JSON.stringify({ok:true,checks,native_tools:52,configured_providers:providers.length,chatgpt_acceptance:'not tested',lease:'revoked; STANDARD'}));
}catch(error){console.error(JSON.stringify({ok:false,error:error.message,checks}));process.exitCode=1;}
finally{for(const client of clients)await client.close().catch(()=>{});}
