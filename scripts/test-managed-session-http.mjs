import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {verifyAuditFile} from '../dist/lib/hash-audit.js';
if(!process.env.BRIDGEDEV_TEST_ROOT)throw Error('Use isolated-tests.mjs');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-session-regression-'));
const work=path.join(root,'work'),source=path.join(root,'source'),audit=path.join(root,'audit.jsonl');
await fs.mkdir(work);await fs.mkdir(path.join(source,'docs/system'),{recursive:true});
const agents=path.join(source,'AGENTS.md'),context=path.join(source,'docs/system/SYSTEM_CONTEXT.md');
await fs.writeFile(agents,'# Fixture agents\n');await fs.writeFile(context,'# Fixture current state\n');
const policy=JSON.parse(await fs.readFile('profiles/policy.example.json','utf8'));
Object.assign(policy,{profile:'standard',context_files:[agents,context],writable_roots:[work],protected_paths:[path.join(work,'protected')],hard_paths:[],secret_paths:[],approval_paths:[],audit_log:audit,proxy_tools:{fixture__echo:'R'}});
const policyFile=path.join(root,'policy.json');await fs.writeFile(policyFile,JSON.stringify(policy));
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
const port=await freePort(),adminPort=await freePort(),token=randomBytes(32).toString('hex'),admin=randomBytes(32).toString('hex'),url=new URL(`http://127.0.0.1:${port}/mcp`);
const env={...process.env,POLICYGATE_POLICY_FILE:policyFile,WORKSPACE_PATH:work,LOCAL_CODER_CHEZMOI_SOURCE_DIR:source,BRIDGEDEV_STATE_DIR:path.join(root,'state'),MCP_UPSTREAM_CONFIG:path.join(root,'upstreams.json'),MCP_TOKEN:token,ADMIN_TOKEN:admin,PORT:String(port),ADMIN_PORT:String(adminPort),MCP_SESSION_TTL_MS:'60000',MCP_SESSION_CLEANUP_MS:'60000',MCP_SESSION_DELETE_GRACE_MS:'100',CHATGPT_TOOL_PROFILE:'slim'};
await fs.writeFile(env.MCP_UPSTREAM_CONFIG,JSON.stringify({servers:[{id:'legacy',transport:'http',url:'https://example.invalid/mcp',enabled:false,reviewed:true,expose:'none'}]}));
let gateway,logs='';const clients=[];
async function start(){gateway=spawn(process.execPath,['dist/index.js'],{env,stdio:['ignore','pipe','pipe']});gateway.stdout.on('data',b=>logs+=b);gateway.stderr.on('data',b=>logs+=b);for(let i=0;i<150;i++){if(gateway.exitCode!==null)throw Error(logs);try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Startup timeout: '+logs);}
async function stop(){if(!gateway||gateway.exitCode!==null)return;const exit=new Promise(resolve=>gateway.once('exit',resolve));await fetch(`http://127.0.0.1:${adminPort}/api/lifecycle/stop`,{method:'POST',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:'{}'});await exit;assert.equal(gateway.exitCode,0,logs);}
function cli(args){const result=spawnSync(process.execPath,['dist/cli.js',...args,'--json'],{env,encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr+' '+result.stdout);return JSON.parse(result.stdout).data;}
async function adminGet(route){const response=await fetch(`http://127.0.0.1:${adminPort}`+route,{headers:{Authorization:'Bearer '+admin}});assert.equal(response.status,200);return response.json();}
async function connect(sessionId){const transport=new StreamableHTTPClientTransport(url,{sessionId,requestInit:{headers:{Authorization:'Bearer '+token}}}),client=new Client({name:'independent-managed-regression',version:'1'},{capabilities:{}});await client.connect(transport);clients.push(client);return {client,transport};}
const call=(client,name,args={})=>client.callTool({name,arguments:args});
async function denied(client,command,pattern=/POLICYGATE_/){const r=await call(client,'run_command',{command});assert.equal(r.isError,true,JSON.stringify(r));assert.match(JSON.stringify(r),pattern);return r;}
async function load(client){const r=await call(client,'system_context',{docs:['agents','current_state']});assert.equal(r.structuredContent?.ok,true,JSON.stringify(r));return r;}
async function allowed(client){const r=await call(client,'run_command',{command:'pwd'});assert.equal(r.structuredContent?.ok,true,JSON.stringify(r));assert.equal(r.structuredContent.data.exit_code,0);return r;}
async function rawCall(name,args,sessionId){const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(sessionId?{'Mcp-Session-Id':sessionId}:{})},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}})});return {status:response.status,id:response.headers.get('mcp-session-id'),exposed:response.headers.get('access-control-expose-headers'),body:await response.json()};}
try{
 await start();let {client:first,transport}=await connect();const firstId=transport.sessionId;
 await denied(first,'pwd',/POLICYGATE_CONTEXT_REQUIRED/);await load(first);await allowed(first);
 const listed=await call(first,'mcp_list');assert.equal(listed.structuredContent.data.initialization_error,undefined);assert.equal(listed.structuredContent.data.configuration.source_schema,'legacy-unversioned');assert.equal(listed.structuredContent.data.providers.length,1);
 assert.equal((await call(first,'mcp_info',{name:'legacy'})).structuredContent.data.config.enabled,false);assert.equal((await call(first,'mcp_status')).structuredContent.data.configuration.migration_required,true);
 for(const route of ['/api/upstream','/api/extensions']){const response=await adminGet(route);assert.equal((response.data||response).configuration.source_schema,'legacy-unversioned');}
 const preview=cli(['mcp','migrate','--config',env.MCP_UPSTREAM_CONFIG,'--dry-run']);assert.deepEqual(preview.diff,[{op:'add',path:'/version',value:1}]);cli(['mcp','migrate','--config',env.MCP_UPSTREAM_CONFIG]);
 const providerFile=path.join(root,'mock-provider.json');await fs.writeFile(providerFile,JSON.stringify({version:1,servers:[{id:'fixture',transport:'stdio',command:process.execPath,args:[path.resolve('scripts/mock-stdio-mcp.mjs')],enabled:true,expose:'all'}]}));
 const registration=cli(['mcp','add',providerFile]);cli(['approve',registration.id]);assert.ok(cli(['mcp','test','fixture']).tools.some(tool=>tool.name==='echo'));
 const enable=cli(['mcp','enable','fixture','--tools','echo','--permission','R']);cli(['approve',enable.id]);assert.ok((await first.listTools()).tools.some(tool=>tool.name==='fixture__echo'));assert.match(JSON.stringify(await call(first,'fixture__echo',{message:'managed-http-lifecycle'})),/echo:managed-http-lifecycle/);
 const disable=cli(['mcp','disable','fixture']);cli(['approve',disable.id]);assert.equal((await call(first,'fixture__echo',{message:'stale'})).isError,true);const remove=cli(['mcp','remove','fixture']);cli(['approve',remove.id]);assert.equal((await call(first,'mcp_list')).structuredContent.data.providers.length,1);

 const second=await connect();await denied(second.client,'pwd',/POLICYGATE_CONTEXT_REQUIRED/);
 await first.close();({client:first}=await connect(firstId));await allowed(first);
 await fs.appendFile(context,'Changed context source\n');await denied(first,'pwd',/POLICYGATE_CONTEXT_REQUIRED/);
 await fs.writeFile(context,'# Fixture current state\n');await denied(first,'pwd',/POLICYGATE_CONTEXT_REQUIRED/);await load(first);await allowed(first);
 await denied(first,'sudo id');await denied(first,'rm -rf /');
 // Missing/failed required documents must never grant authorization.
 await fs.rename(agents,agents+'.saved');assert.equal((await call(second.client,'system_context',{docs:['agents','current_state']})).isError,true);await denied(second.client,'pwd',/POLICYGATE_CONTEXT_REQUIRED/);await fs.rename(agents+'.saved',agents);
 // The adoption path publishes a usable session ID; omitting it again creates
 // an unrelated policy session and cannot inherit authorization.
 const adopted=await rawCall('system_context',{docs:['agents','current_state']});assert.equal(adopted.status,200);assert.ok(adopted.id);assert.match(adopted.exposed,/Mcp-Session-Id/i);assert.equal(adopted.body.result.structuredContent.ok,true);
 const retained=await rawCall('run_command',{command:'pwd'},adopted.id);assert.equal(retained.body.result.structuredContent.ok,true);
 const dropped=await rawCall('run_command',{command:'pwd'});assert.match(JSON.stringify(dropped.body),/POLICYGATE_CONTEXT_REQUIRED/);
 const unknown=await rawCall('run_command',{command:'pwd'},randomUUID());assert.match(JSON.stringify(unknown.body),/POLICYGATE_CONTEXT_REQUIRED/);
 const deleted=await connect();await load(deleted.client);const deletedId=deleted.transport.sessionId;await deleted.transport.terminateSession();
 const stale=await rawCall('run_command',{command:'pwd'},deletedId);assert.ok(stale.status>=400||stale.body.result?.isError,JSON.stringify(stale));
 await new Promise(r=>setTimeout(r,150));const recovered=await rawCall('run_command',{command:'pwd'},deletedId);assert.match(JSON.stringify(recovered.body),/POLICYGATE_CONTEXT_REQUIRED/);
 for(const c of clients)await c.close();await stop();
 env.MCP_SESSION_TTL_MS='2000';await start();const expiring=await connect();await load(expiring.client);await new Promise(r=>setTimeout(r,2200));await denied(expiring.client,'pwd',/POLICYGATE_CONTEXT_REQUIRED/);await load(expiring.client);await allowed(expiring.client);
 await fs.writeFile(env.POLICYGATE_MODE_FILE,JSON.stringify({mode:'strict'}));await denied(expiring.client,'pwd',/POLICYGATE_APPROVAL_REQUIRED/);await denied(expiring.client,'sudo id');
 await expiring.client.close();await stop();
 const records=(await fs.readFile(audit,'utf8')).trim().split('\n').map(JSON.parse);for(const status of ['granted','invalidated','denied'])assert.ok(records.some(r=>r.phase==='context_authorization'&&r.status===status),status);
 const grant=records.find(r=>r.phase==='context_authorization'&&r.status==='granted');assert.ok(grant.mcp_session_id&&grant.session_id&&grant.mcp_session_id!==grant.session_id);
 assert.ok(verifyAuditFile(audit).entries>0);assert.ok(!logs.includes(token)&&!logs.includes(admin));
 console.log('Managed HTTP sessions: initialize/context/command, independent client, reconnect, changed/missing sources, headerless adoption, DELETE/recovery, TTL, strict approvals and audit PASS');
}finally{for(const c of clients)await c.close().catch(()=>{});await stop();await fs.rm(root,{recursive:true,force:true});assert.equal(await fs.stat(root).then(()=>true,()=>false),false);}
