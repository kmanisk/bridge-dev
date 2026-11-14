import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {fixturePorts} from './test-ports.mjs';
import {NATIVE_TOOL_CLASSES,classifyTool} from '../dist/lib/tool-classification.js';
import {toolResult} from '../dist/lib/tool-result.js';
if(!process.env.BRIDGEDEV_TEST_ROOT)throw Error('Use isolated-tests.mjs');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-output-schema-')),work=path.join(root,'work');
await fs.mkdir(work);await fs.writeFile(path.join(work,'visible.txt'),'schema fixture\n');await fs.writeFile(path.join(work,'AGENTS.md'),'# Fixture agents\n');
await fs.mkdir(path.join(work,'.agents/skills/schema'),{recursive:true});await fs.writeFile(path.join(work,'.agents/skills/schema/SKILL.md'),'---\nname: schema\ndescription: Fixture guidance\n---\nRead only.\n');
for(const args of [['init','-q',work],['-C',work,'add','.'],['-C',work,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']])assert.equal(spawnSync('git',args,{env:process.env,encoding:'utf8'}).status,0);
const policy=JSON.parse(await fs.readFile(process.env.POLICYGATE_POLICY_FILE,'utf8'));Object.assign(policy,{profile:'standard',writable_roots:[work],hard_paths:[],protected_paths:[],secret_paths:[],approval_paths:[],audit_log:path.join(root,'audit.jsonl')});
const names=['open','closed','empty','dictionary','union','nested','missing','wrong','extra','null','array','error','error_bad'];policy.proxy_tools=Object.fromEntries(names.map(name=>['schema__'+name,'R']));
const pf=path.join(root,'policy.json');await fs.writeFile(pf,JSON.stringify(policy));const mode=path.join(root,'mode.json'),providers=path.join(root,'providers.json');
await fs.writeFile(providers,JSON.stringify({version:1,servers:[{id:'schema',name:'Schema fixture',transport:'stdio',command:process.execPath,args:[path.resolve('scripts/mock-schema-mcp.mjs')],enabled:true,reviewed:true,expose:'all',tool_permissions:Object.fromEntries(names.map(name=>[name,'R']))}]}));
const [port,adminPort]=await fixturePorts(2),token=randomBytes(32).toString('hex'),admin=randomBytes(32).toString('hex');
const env={...process.env,POLICYGATE_POLICY_FILE:pf,POLICYGATE_MODE_FILE:mode,BRIDGEDEV_RUNTIME_MODE:'managed',WORKSPACE_PATH:work,BRIDGEDEV_STATE_DIR:path.join(root,'state'),MCP_UPSTREAM_CONFIG:providers,MCP_TOKEN:token,ADMIN_TOKEN:admin,PORT:String(port),ADMIN_PORT:String(adminPort),CHATGPT_TOOL_PROFILE:'full'};
const file=path.join(work,'visible.txt'),dest=path.join(work,'destination.txt');
const cases={
 system_context:{docs:['agents','current_state']},system_inspect:{sections:['resources']},chezmoi_inspect:{path:file},read_text_file:{path:file},read_file_base64:{path:file},
 list_directory:{path:work},glob:{path:work,pattern:'*.txt'},grep:{path:work,pattern:'fixture'},search_files:{path:work,pattern:'fixture'},directory_tree:{path:work,max_depth:1},list_allowed_directories:{},
 git_status:{path:work},git_diff:{path:work},git_log:{path:work,count:1},git_branch:{path:work,action:'list'},git_stash:{path:work,action:'list'},
 shell_status:{},process_status:{},process_output:{id:'schema-missing-process'},system_job:{action:'list'},rewind:{action:'list'},list_skills:{},load_skill:{name:'schema'},project_context:{path:work,max_depth:0},agent_status:{},load_path_rules:{path:file},mcp_servers:{refresh:false},mcp_tools:{server_id:'schema'},mcp_info:{name:'schema'},mcp_list:{},mcp_status:{},skills_validate:{},
 extensions_list:{},extensions_info:{name:'schema'},extensions_search:{query:'schema'},skills_list:{},skills_info:{name:'schema'},
 extensions_propose_add:{source:'https://fixture.invalid/never-fetched.git'},extensions_propose_remove:{name:'skill:schema'},mcp_propose_add:{source:'https://fixture.invalid/mcp'},mcp_propose_update:{name:'schema'},mcp_propose_remove:{name:'schema'},mcp_propose_disable:{name:'schema'},skills_propose_add:{source:'https://fixture.invalid/SKILL.md'},skills_propose_remove:{name:'schema'},
 write_file:{path:dest,content:'fixture'},write_file_base64:{path:dest,content:'Zml4dHVyZQ=='},edit_file:{path:file,old_text:'fixture',new_text:'changed'},multi_edit:{path:file,edits:[{old_text:'fixture',new_text:'changed'}]},replace_regex:{path:file,pattern:'fixture',replacement:'changed'},apply_patch:{path:file,patch:'@@\n-schema fixture\n+changed\n'},delete_file:{path:file},create_directory:{path:path.join(work,'new')},delete_directory:{path:path.join(work,'new')},copy_file:{source:file,destination:dest},move_file:{source:file,destination:dest},
 git_add:{path:work,files:['visible.txt'],all:false},git_commit:{path:work,message:'must be denied'},git_checkout:{path:work,branch:'main'},git_restore:{path:work,files:['visible.txt']},git_push:{path:work},git_pull:{path:work},git_reset:{path:work,mode:'hard'},run_command:{command:'sudo -n id'},shell_reset:{},start_process:{command:'sudo -n id'},stop_process:{id:'schema-missing-process'},clear_processes:{},node_repl:{code:'1+1'},ponytail_turn:{prompt:'fixture'},remember:{note:'must be denied'},mcp_call:{server_id:'schema',tool:'closed'},mcp_test:{name:'schema',provider_fingerprint:'0'.repeat(64)},
};
assert.deepEqual(Object.keys(cases).sort(),Object.keys(NATIVE_TOOL_CLASSES).sort(),'Every registration must have an explicit safe/denied schema case');
for(const bad of [[],null,undefined,1,'text'])assert.throws(()=>toolResult('invalid-fixture',bad),/DATA_MUST_BE_OBJECT/);
let gateway,logs='',client,transport;const validator=new AjvJsonSchemaValidator();
async function connect(){const c=new Client({name:'schema-validating-client',version:'1'},{capabilities:{}}),t=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}});await c.connect(t);const tools=(await c.listTools()).tools;return {c,t,tools};}
async function close(c,t){await t.terminateSession().catch(()=>{});await c.close();}
function cli(args){const r=spawnSync(process.execPath,['dist/cli.js',...args,'--json'],{env,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).data;}
async function checked(c,tool,args){
 assert.equal(validator.getValidator(tool.inputSchema)(args).valid,true,'Invalid test arguments: '+tool.name);
 const result=await c.callTool({name:tool.name,arguments:args});CallToolResultSchema.parse(result);
 assert.doesNotMatch(JSON.stringify(result),/Output validation error|Invalid structured content|does not conform to output schema/i,'Schema error disguised as a tool error: '+tool.name);
 if(result.structuredContent)assert.equal(validator.getValidator(tool.outputSchema)(result.structuredContent).valid,true,'Structured response failed: '+tool.name);
 else assert.equal(result.isError,true,'Missing success structuredContent: '+tool.name);
 return result;
}
try{
 gateway=spawn(process.execPath,['dist/index.js'],{env,stdio:['ignore','pipe','pipe']});gateway.stdout.on('data',b=>logs+=b);gateway.stderr.on('data',b=>logs+=b);
 for(let n=0;n<150;n++){if(gateway.exitCode!==null)throw Error(logs);try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 ({c:client,t:transport}=await connect());let tools=[];
 for(let n=0;n<150;n++){tools=(await client.listTools()).tools;if(tools.filter(t=>t.name.startsWith('schema__')).length===names.length)break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(tools.filter(t=>!t.name.startsWith('schema__')).length,73);
 const proxy=tools.filter(t=>t.name.startsWith('schema__'));assert.equal(proxy.length,names.length,JSON.stringify((await client.callTool({name:'mcp_status',arguments:{}})).structuredContent));
 const byName=name=>tools.find(t=>t.name===name);
 for(const name of ['open','closed','empty','dictionary','union','nested','error']){
  const tool=byName('schema__'+name);assert.ok(tool.outputSchema,'Provider output schema dropped: '+name);
  const result=await checked(client,tool,name==='union'?{value:4}:{});assert.equal(Boolean(result.isError),name==='error');
 }
 assert.equal(byName('schema__empty').outputSchema.additionalProperties,false);
 assert.deepEqual(byName('schema__union').outputSchema.properties.value.type,['string','integer','null']);
 assert.equal((await checked(client,byName('schema__union'),{value:null})).structuredContent.value,null);
 for(const name of ['missing','wrong','extra','null','array','error_bad']){
  const result=await client.callTool({name:'schema__'+name,arguments:{}});CallToolResultSchema.parse(result);assert.equal(result.isError,true,'Invalid upstream output was accepted: '+name);assert.equal(result.structuredContent,undefined);
 }
 assert.deepEqual((await checked(client,byName('skills_validate'),{})).structuredContent.data,{results:[],ok:true,count:0});
 const installation=cli(['skills','add',path.join(work,'.agents/skills/schema')]);cli(['approve',installation.id]);
 const results=[{key:'skill:schema',valid:true}];
 assert.deepEqual(cli(['skills','validate']),results);
 const lockFile=path.join(work,'.bridge-dev/managed/lock.json'),lock=JSON.parse(await fs.readFile(lockFile,'utf8'));
 lock.entries[0].component.files['SKILL.md']='invalid fixture guidance';await fs.writeFile(lockFile,JSON.stringify(lock));
 const invalid=await checked(client,byName('skills_validate'),{});assert.equal(invalid.structuredContent.data.ok,false);assert.equal(invalid.structuredContent.data.count,1);assert.equal(invalid.structuredContent.data.results[0].valid,false);assert.equal(typeof invalid.structuredContent.data.results[0].error,'string');
 lock.entries[0].component.files['SKILL.md']=await fs.readFile(path.join(work,'.agents/skills/schema/SKILL.md'),'utf8');await fs.writeFile(lockFile,JSON.stringify(lock));
 // STRICT supplies real policy denials without executing any mutation. Providers
 // above run in STANDARD; switching to STRICT must never enable stdio execution.
 await fs.writeFile(mode,JSON.stringify({mode:'strict'}));
 const covered=[];
 for(const tool of tools.filter(t=>!t.name.startsWith('schema__'))){
  const args=cases[tool.name],kind=classifyTool(tool.name,args).kind;
  if(kind==='R'){
   const result=await checked(client,tool,args);
   if(tool.name!=='process_output')assert.ok(result.structuredContent,'Read tool returned an unexpected error: '+tool.name+' '+JSON.stringify(result));
   if(tool.name==='skills_validate')assert.deepEqual(result.structuredContent.data,{results,ok:true,count:1});
  }else{
   const {c,t,tools:manifest}=await connect();try{await c.callTool({name:'system_context',arguments:{docs:['agents','current_state']}});const result=await checked(c,manifest.find(x=>x.name===tool.name),args);assert.equal(result.isError,true,'Unsafe tool was executed: '+tool.name);assert.match(JSON.stringify(result),/POLICYGATE_/);}finally{await close(c,t);}
  }
  covered.push(tool.name);
 }
 // CLI JSON retains the pre-existing array contract independently of the MCP wrapper.
 assert.deepEqual(cli(['skills','validate']),results);
 assert.equal(covered.length,73);assert.equal(await fs.readFile(file,'utf8'),'schema fixture\n');assert.equal((await fs.readdir(work)).includes('destination.txt'),false);
 console.log('Output schemas: real HTTP SDK client validated all 73 native tools (safe reads/proposals and policy denials), 13 routed fixtures, nullable unions/open/closed/dictionary/nested output, malformed upstream rejection and unchanged CLI arrays PASS');
}finally{
 if(client)await close(client,transport).catch(()=>{});
 if(gateway&&gateway.exitCode===null){const exited=new Promise(r=>gateway.once('exit',r));try{await fetch(`http://127.0.0.1:${adminPort}/api/lifecycle/stop`,{method:'POST',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:'{}'});}catch{gateway.kill();}await Promise.race([exited,new Promise(r=>setTimeout(r,2500))]);if(gateway.exitCode===null)gateway.kill('SIGKILL');await exited;}
 await fs.rm(root,{recursive:true,force:true});
}
