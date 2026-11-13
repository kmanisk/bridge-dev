import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const base=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-router-'));
const configPath=path.join(base,'mcp.json');
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const mock=spawn(process.execPath,['scripts/mock-http-mcp.mjs'],{env:{MOCK_HTTP_MCP_PORT:String(port)},stdio:'ignore'});
let manager,client,server;
try{
 const policy=JSON.parse(await fs.readFile(process.env.POLICYGATE_POLICY_FILE,'utf8'));
 policy.proxy_tools={http__add:'R',stdio__echo:'R',stdio__environment:'R'};
 const pf=path.join(base,'policy.json');await fs.writeFile(pf,JSON.stringify(policy));process.env.POLICYGATE_POLICY_FILE=pf;
 const {McpUpstreamManager}=await import('../dist/lib/mcp-upstream-manager.js');
 const {createMcpServer}=await import('../dist/server-factory.js');
 const {refreshProxiedTools}=await import('../dist/lib/mcp-tool-proxy.js');
 const {proxyToolName,validateToolArguments}=await import('../dist/lib/provider-security.js');
 const {saveUpstreamConfig,parseMcpServersFile}=await import('../dist/lib/mcp-upstream-config.js');
 const {validateNetworkUrl,isPublicAddress}=await import('../dist/lib/safe-network.js');
 const imported=parseMcpServersFile({mcpServers:{bad:{command:'unreviewed',enabled:true}}});
 assert.equal(imported[0].enabled,false);assert.equal(imported[0].expose,'none');
 assert.match(proxyToolName('p'.repeat(48),'abc.'.repeat(60)),/^[\w-]{1,64}$/);
 assert.notEqual(proxyToolName('p','a.b'),proxyToolName('p','a_b'));
 assert.throws(()=>validateToolArguments({name:'test',inputSchema:{type:'object',properties:{n:{type:'integer',minimum:2}},required:['n'],additionalProperties:false}},{n:1}),/INVALID_ARGUMENTS/);
 assert.throws(()=>validateToolArguments({name:'test',inputSchema:{type:'object',additionalProperties:false}},{extra:1}),/INVALID_ARGUMENTS/);
 for(const url of ['http://127.0.0.1','https://[::ffff:127.0.0.1]','https://169.254.169.254','https://user:pass@example.com'])await assert.rejects(validateNetworkUrl(url));
 assert.equal(isPublicAddress('127.0.0.1'),false);assert.equal(isPublicAddress('8.8.8.8'),true);
 for(let attempt=0;attempt<60;attempt++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
 manager=new McpUpstreamManager(configPath);await manager.init();
 const http={id:'http',name:'Mock HTTP',enabled:true,transport:'http',url:`http://127.0.0.1:${port}/mcp`,auth:{type:'none'},allow_private_network:true,expose:'allowlist',tools:['add']};
 const stdio={id:'stdio',name:'Mock stdio',enabled:true,transport:'stdio',command:process.execPath,args:[path.resolve('scripts/mock-stdio-mcp.mjs')],env:{PROVIDER_CHILD_FILE:path.join(base,'child.pid')},expose:'allowlist',tools:['echo','environment']};
 await manager.updateConfig({version:1,servers:[http,stdio]});
 server=createMcpServer(process.env.WORKSPACE_PATH,10,[process.env.WORKSPACE_PATH],false,manager);
 await refreshProxiedTools(server,manager);
 client=new Client({name:'independent-aggregation-client',version:'1'},{capabilities:{}});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const tools=(await client.listTools()).tools.map(t=>t.name);assert.ok(tools.includes('http__add')&&tools.includes('stdio__echo'));
 assert.match(JSON.stringify(await client.callTool({name:'http__add',arguments:{a:2,b:3}})),/5/);
 assert.match(JSON.stringify(await client.callTool({name:'stdio__echo',arguments:{message:'via-gateway'}})),/via-gateway/);
 const environment=await client.callTool({name:'stdio__environment',arguments:{}});
 assert.doesNotMatch(JSON.stringify(environment),/MCP_TOKEN|ADMIN_TOKEN|HOME|POLICYGATE/);
 const beforeChild=Number(await fs.readFile(path.join(base,'child.pid'),'utf8')),beforePid=manager.listStatusesCached().find(s=>s.id==='stdio').pid;
 process.kill(beforePid,'SIGKILL');await new Promise(r=>setTimeout(r,150));
 assert.match(JSON.stringify(await manager.callTool('stdio','echo',{message:'after-crash'})),/after-crash/);
 let oldAlive=false;try{process.kill(beforeChild,0);oldAlive=true;}catch{}assert.equal(oldAlive,false,'Provider crash left its original child');
 const childPid=Number(await fs.readFile(path.join(base,'child.pid'),'utf8'));
 const stdioPid=manager.listStatusesCached().find(s=>s.id==='stdio').pid;
 await manager.updateConfig({version:1,servers:[http,{...stdio,enabled:false}]});
 assert.equal((await client.callTool({name:'stdio__echo',arguments:{message:'stale'}})).isError,true);
 await assert.rejects(manager.callTool('stdio','echo',{message:'stale'}),/DENIED/);
 await new Promise(r=>setTimeout(r,100));
 for(const pid of [stdioPid,childPid]){let alive=false;try{process.kill(pid,0);alive=true;}catch{}assert.equal(alive,false,`provider tree PID ${pid} survived`);}
 await assert.rejects(saveUpstreamConfig({version:1,servers:[http,{...http,id:'other',tool_prefix:'http'}]},configPath),/COLLISION/);
 const reloaded=new McpUpstreamManager(configPath);await reloaded.init();assert.equal(reloaded.getServerConfig('stdio').enabled,false);await reloaded.shutdown();
 await manager.removeServer('stdio');assert.equal(manager.getServerConfig('stdio'),undefined);
 await fs.writeFile(configPath,'{corrupted');const broken=new McpUpstreamManager(configPath);await broken.init();assert.ok(broken.initializationError);assert.deepEqual(broken.listServerConfigs(),[]);
 const cleanup=new McpUpstreamManager(path.join(base,'cleanup.json'));await cleanup.init();
 await cleanup.updateConfig({version:1,servers:[{...stdio,id:'first',env:{}},{...stdio,id:'second',env:{}}]});
 await cleanup.listTools('first');await cleanup.listTools('second');
 const failed=cleanup.connections.get('first'),restore=failed.transport.close.bind(failed.transport),secondPid=cleanup.listStatusesCached().find(s=>s.id==='second').pid;
 failed.transport.close=async()=>{throw Error('fixture cleanup failure');};
 try{await assert.rejects(cleanup.shutdown(),/cleanup failed/i);let alive=false;try{process.kill(secondPid,0);alive=true;}catch{}assert.equal(alive,false,'One cleanup failure prevented sibling provider cleanup');}
 finally{failed.transport.close=restore;await cleanup.shutdown();}
 console.log('Provider router: two transports, client calls, default deny, schemas, SSRF, persistence, collisions, stale tools and child cleanup PASS');
}finally{
 await client?.close();await server?.close();await manager?.shutdown();mock.kill();await new Promise(r=>mock.exitCode!==null?r():mock.once('exit',r));await fs.rm(base,{recursive:true,force:true});
}
