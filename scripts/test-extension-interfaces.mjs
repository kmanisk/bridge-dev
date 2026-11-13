import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-interface-'));
const getPort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const port=await getPort(),adminPort=await getPort(),token=randomBytes(32).toString('hex'),admin=randomBytes(32).toString('hex');
const work=path.join(root,'work'),source=path.join(root,'source');await fs.mkdir(work);await fs.mkdir(path.join(source,'skills','demo'),{recursive:true});
await fs.writeFile(path.join(source,'skills','demo','SKILL.md'),'---\nname: demo\ndescription: Fixture guidance\n---\n# Safe fixture\n');
await fs.writeFile(path.join(source,'bridge-dev.json'),JSON.stringify({version:1,servers:[{id:'fixture',name:'Generic fixture',enabled:true,transport:'stdio',command:process.execPath,args:[path.resolve('scripts/mock-stdio-mcp.mjs')],expose:'all'}]}));
const env={...process.env,POLICYGATE_POLICY_FILE:'',BRIDGEDEV_RUNTIME_MODE:'portable',WORKSPACE_PATH:work,BRIDGEDEV_STATE_DIR:path.join(root,'state'),MCP_UPSTREAM_CONFIG:path.join(root,'providers.json'),MCP_TOKEN:token,ADMIN_TOKEN:admin,PORT:String(port),ADMIN_PORT:String(adminPort)};
let gateway,logs='',client;
function cli(args,overrides={}){const run=spawnSync(process.execPath,['dist/cli.js',...args,'--json'],{env:{...env,...overrides},encoding:'utf8',timeout:30000});assert.equal(run.status,0,run.stderr+' '+run.stdout);return JSON.parse(run.stdout).data;}
async function api(route,body,credential=admin){const r=await fetch(`http://127.0.0.1:${adminPort}`+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
async function start(){gateway=spawn(process.execPath,['dist/index.js'],{env,stdio:['ignore','pipe','pipe']});gateway.stdout.on('data',b=>logs+=b);gateway.stderr.on('data',b=>logs+=b);for(let i=0;i<100;i++){if(gateway.exitCode!==null)throw Error(logs);try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error(logs);}
async function stop(){if(!gateway||gateway.exitCode!==null)return;gateway.kill('SIGTERM');await new Promise(resolve=>gateway.once('exit',resolve));assert.equal(gateway.exitCode,0,logs);}
try{
 await start();
 assert.equal((await api('/api/extensions',undefined,token)).status,401);
 assert.equal((await fetch(`http://127.0.0.1:${adminPort}/ui/`)).status,200,'Public login assets only');
 const initial=await api('/api/extensions');assert.equal(initial.body.data.providers.length,0);
 const choices=cli(['add',source]);assert.equal(choices.components.length,2);
 const proposed=cli(['add',source,'--select','mcp:fixture']);assert.equal((await api('/api/extensions')).body.data.providers.length,0);
 assert.equal((await api('/api/extensions/apply',{id:proposed.id},token)).status,401);
 cli(['approve',proposed.id]);assert.equal((await api('/api/extensions')).body.data.providers[0].enabled,false);
 const tested=cli(['mcp','test','fixture']);assert.ok(tested.tools.some(tool=>tool.name==='echo'));
 const enable=cli(['mcp','enable','fixture','--tools','echo','--permission','R']);assert.equal(enable.provider.command,process.execPath);cli(['approve',enable.id]);
 client=new Client({name:'independent-web-client',version:'1'},{capabilities:{}});
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 const tools=(await client.listTools()).tools;assert.ok(tools.some(tool=>tool.name==='fixture__echo'));assert.ok(tools.some(tool=>tool.name==='extensions_propose_add'));
 const call=await client.callTool({name:'fixture__echo',arguments:{message:'actual-gateway'}});assert.match(JSON.stringify(call),/echo:actual-gateway/);
 const request=await client.callTool({name:'extensions_propose_add',arguments:{source:'https://fixture.invalid/never-contacted.git'}});assert.match(JSON.stringify(request),/operator_review_required/);
 assert.equal((await api('/api/extensions')).body.data.requests.length,1);
 const selfApprove=await client.callTool({name:'extensions_approve',arguments:{id:enable.id}});assert.equal(selfApprove.isError,true);
 const skill=cli(['skills','add',source]);cli(['approve',skill.id]);const skillEnable=cli(['skills','enable','demo']);cli(['approve',skillEnable.id]);
 const loaded=await client.callTool({name:'load_skill',arguments:{name:'demo'}});assert.match(JSON.stringify(loaded),/Untrusted skill guidance/);
 const disabled=cli(['mcp','disable','fixture']);cli(['approve',disabled.id]);
 const stale=await client.callTool({name:'fixture__echo',arguments:{message:'stale'}});assert.equal(stale.isError,true);
 await client.close();client=null;await stop();await start();assert.equal((await api('/api/extensions')).body.data.providers[0].enabled,false);
 const remove=cli(['mcp','remove','fixture']);cli(['approve',remove.id]);assert.equal((await api('/api/extensions')).body.data.providers.length,0);
 assert.ok(!logs.includes(token)&&!logs.includes(admin),'Credentials leaked to gateway logs');
 console.log('Extension interfaces: CLI preview/approval, authenticated admin, independent HTTP client, allowlisted proxy, skill load, model request, self-approval refusal, disable, restart and removal PASS');
}finally{await client?.close().catch(()=>{});await stop();await fs.rm(root,{recursive:true,force:true});}
