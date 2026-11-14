// Explicit, privileged Linux rehearsal; never run by normal CI/test configuration.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createFixtures,activateFixtures,preflightFixtures,cleanupFixtures} from './fixtures.mjs';
import {acceptGateway} from './client.mjs';
import {fixturePorts} from '../test-ports.mjs';
const [sourceUnit,parent,receipt]=process.argv.slice(2),repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(process.platform!=='linux'||process.getuid()!==0||!sourceUnit||!parent||!receipt)throw Error('Explicit root use: rehearse-host.mjs <existing-unit> <visible-scratch-parent> <receipt>');
const oldUmask=process.umask(0o077);
const run=(argv)=>{const r=spawnSync(argv[0],argv.slice(1),{encoding:'utf8',env:{PATH:'/usr/bin:/bin'},timeout:30000});if(r.status!==0)throw Error('Rehearsal command failed: '+path.basename(argv[0]));return r.stdout;};
const keys=['User','Group','UMask','ProtectHome','ProtectSystem','PrivateTmp','NoNewPrivileges','ProtectKernelTunables','ProtectControlGroups','RestrictRealtime','MemoryDenyWriteExecute','ReadOnlyPaths','BindPaths','BindReadOnlyPaths'];
const properties=Object.fromEntries(run(['/usr/bin/systemctl','show',sourceUnit,...keys.map(k=>'--property='+k)]).trim().split('\n').map(line=>line.split(/=(.*)/s).slice(0,2)));
if(!properties.User||properties.User==='root')throw Error('Restricted source unit required');
const uid=Number(run(['/usr/bin/id','-u',properties.User]).trim()),gid=Number(run(['/usr/bin/id','-g',properties.User]).trim());
const base=fs.mkdtempSync(path.join(fs.realpathSync(parent),'bridge-acceptance-rehearsal-')),work=path.join(base,'work'),state=path.join(base,'state'),source=path.join(base,'source'),release=path.join(base,'release'),unit='bridge-dev-rehearsal-'+randomUUID();
const [port,adminPort]=await fixturePorts(2),token=randomBytes(32).toString('hex'),admin=randomBytes(32).toString('hex');let plan,started=false,client,transport,result;
const mkdir=(p,mode=0o755,owner=0)=>{fs.mkdirSync(p,{recursive:true});fs.chmodSync(p,mode);fs.chownSync(p,owner,owner===uid?gid:0);};
const write=(p,text,mode=0o644)=>{fs.writeFileSync(p,text);fs.chmodSync(p,mode);};
try{
 fs.chmodSync(base,0o755);mkdir(work,0o755,uid);mkdir(state,0o700,uid);mkdir(source);mkdir(path.join(source,'docs'));mkdir(path.join(source,'docs/system'));mkdir(release);
 for(const name of ['dist','scripts','public','profiles','node_modules','package.json','pnpm-lock.yaml'])fs.cpSync(path.join(repo,name),path.join(release,name),{recursive:true,dereference:false,verbatimSymlinks:true});
 function seal(p){const st=fs.lstatSync(p);if(st.isSymbolicLink()){if(!fs.realpathSync(p).startsWith(release+path.sep))throw Error('Rehearsal code link escapes copy');return;}fs.chownSync(p,0,0);fs.chmodSync(p,st.isDirectory()?0o755:(st.mode&0o111)?0o755:0o644);if(st.isDirectory())for(const name of fs.readdirSync(p))seal(path.join(p,name));}seal(release);write(path.join(release,'DEPLOYED_COMMIT'),'0'.repeat(40)+'\n');
 write(path.join(source,'AGENTS.md'),'# Fixture agents\n');write(path.join(source,'docs/system/SYSTEM_CONTEXT.md'),'# Fixture state\n');write(path.join(source,'docs/system/system-philosophy.md'),'# Fixture philosophy\n');write(path.join(source,'docs/system/SUBSYSTEM_MAP.md'),'# Fixture map\n');
 const policy=JSON.parse(fs.readFileSync(path.join(repo,'profiles/policy.example.json')));Object.assign(policy,{profile:'standard',context_files:[path.join(source,'AGENTS.md'),path.join(source,'docs/system/SYSTEM_CONTEXT.md')],writable_roots:[work],protected_paths:[],secret_paths:[],hard_paths:[],approval_paths:[],audit_log:path.join(state,'policy-audit.jsonl')});
 write(path.join(state,'policy.json'),JSON.stringify(policy));write(path.join(state,'providers.json'),JSON.stringify({version:1,servers:[]}));write(path.join(state,'hooks.json'),JSON.stringify({enabled:false,hooks:[]}));
 const env={PATH:'/usr/bin:/bin',HOME:state,XDG_CONFIG_HOME:path.join(state,'config'),XDG_DATA_HOME:path.join(state,'data'),XDG_STATE_HOME:state,XDG_CACHE_HOME:path.join(state,'cache'),BRIDGEDEV_TEST_ROOT:base,BRIDGEDEV_RUNTIME_MODE:'managed',BRIDGEDEV_STATE_DIR:state,WORKSPACE_PATH:work,HOST:'127.0.0.1',PORT:String(port),ADMIN_PORT:String(adminPort),MCP_TOKEN:token,ADMIN_TOKEN:admin,CHATGPT_TOOL_PROFILE:'slim',DOTENV_CONFIG_PATH:'/dev/null',POLICYGATE_POLICY_FILE:path.join(state,'policy.json'),POLICYGATE_MODE_FILE:path.join(state,'mode.json'),POLICYGATE_APPROVAL_DIR:path.join(state,'approvals'),POLICYGATE_APPROVAL_PUBLIC_KEY:'',POLICYGATE_YOLO_LEASE:path.join(state,'lease.json'),POLICYGATE_AUDIT_ANCHOR_FILE:path.join(state,'anchor.json'),MCP_UPSTREAM_CONFIG:path.join(state,'providers.json'),MCP_OAUTH_STORE:path.join(state,'oauth'),MCP_SHELL_STATE_DIR:path.join(state,'shell'),AUDIT_LOG_PATH:path.join(state,'activity.jsonl'),POST_EDIT_HOOKS_CONFIG:path.join(state,'hooks.json'),LOCAL_CODER_CHEZMOI_SOURCE_DIR:source,LOCAL_CODER_CHEZMOI_DESTINATION_DIR:work,CHECKPOINT_ENABLED:'false',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 const envFile=path.join(base,'rehearsal.env');write(envFile,Object.entries(env).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',0o600);
 const props=Object.entries(properties).filter(([,v])=>v).map(([k,v])=>'--property='+k+'='+v);props.push('--property=ReadOnlyPaths='+properties.ReadOnlyPaths+' '+release);
 plan=createFixtures(work,uid,gid,true);
 run(['/usr/bin/systemd-run','--unit='+unit,'--collect','--property=Type=simple','--property=Restart=no','--property=RuntimeMaxSec=150s','--property=WorkingDirectory='+work,'--property=EnvironmentFile='+envFile,...props,'/usr/bin/node',path.join(release,'dist/index.js')]);started=true;
 let ready=false;for(let n=0;n<150;n++){try{if((await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Rehearsal gateway health deadline');
 const pid=Number(run(['/usr/bin/systemctl','show',unit,'--property=MainPID','--value']).trim());
 const actual=Object.fromEntries(run(['/usr/bin/systemctl','show',unit,...keys.map(k=>'--property='+k)]).trim().split('\n').map(line=>line.split(/=(.*)/s).slice(0,2)));
 for(const key of keys)if(key!=='ReadOnlyPaths'&&actual[key]!==properties[key])throw Error('Rehearsal property differs: '+key);
 if(actual.ReadOnlyPaths!==properties.ReadOnlyPaths+' '+release)throw Error('ReadOnlyPaths differ');
 const positive=preflightFixtures(plan,pid);
 client=new Client({name:'root-permission-rehearsal',version:'1'},{capabilities:{}});transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}});await client.connect(transport);await client.listTools();
 if(JSON.stringify(await client.callTool({name:'list_skills',arguments:{}})).includes(plan.skillName))throw Error('Dormant fixture was discovered');
 activateFixtures(plan);preflightFixtures(plan,pid);
 const skill=path.join(plan.skillDirectory,'SKILL.md');
 async function negative(change,restore){change();try{let rejected=false;try{preflightFixtures(plan,pid);}catch(error){rejected=/ACCEPTANCE_FIXTURE_UNREADABLE: skill/.test(error.message);}if(!rejected)throw Error('Unreadable fixture passed preflight');const r=await client.callTool({name:'load_skill',arguments:{name:plan.skillName}});if(!r.isError||!/SKILL_PERMISSION_DENIED/.test(JSON.stringify(r))||JSON.stringify(r).includes(base))throw Error('Permission diagnostic failed');}finally{restore();}}
 await negative(()=>{fs.chownSync(skill,0,0);fs.chmodSync(skill,0o600);},()=>{fs.chmodSync(skill,0o444);fs.chownSync(skill,uid,gid);});
 const parentDir=plan.createdParents[0];await negative(()=>fs.chmodSync(parentDir,0o700),()=>fs.chmodSync(parentDir,0o755));
 const acceptance=await acceptGateway({url:`http://127.0.0.1:${port}/mcp`,adminUrl:`http://127.0.0.1:${adminPort}`,mcpToken:token,adminToken:admin,fixtures:plan,inventory:JSON.parse(fs.readFileSync(path.join(repo,'profiles/native-tool-counts.json'))).tools.slim});
 const cliPlan=path.join(base,'cli-fixtures.json');
 for(const action of ['fixtures','accept','cleanup'])run(['/usr/bin/node',path.join(release,'scripts/deploy-acceptance/run.mjs'),action,release,envFile,String(pid),cliPlan]);
 result={ok:true,operator_cli_fixture_accept_cleanup:true,dormant_fixture_not_discovered_at_startup:true,fixture_builder_umask:'0077',source_unit:sourceUnit,rehearsal_unit:unit,uid,gid,properties,actual_properties:actual,positive_preflight:positive,root_0600_negative_detected:true,parent_0700_negative_detected:true,permission_errors_non_leaky:true,acceptance,production_credentials_or_state_used:false};
}catch(error){result={ok:false,error:error.message};process.exitCode=1;}
finally{
 await transport?.terminateSession().catch(()=>{});await client?.close().catch(()=>{});
 if(started)run(['/usr/bin/systemctl','stop',unit]);
 if(plan)cleanupFixtures(plan);fs.rmSync(base,{recursive:true,force:true});
 process.umask(oldUmask);
 if(result){result.cleaned_up=true;write(receipt,JSON.stringify(result,null,2)+'\n',0o600);console.log(JSON.stringify(result));}
}
