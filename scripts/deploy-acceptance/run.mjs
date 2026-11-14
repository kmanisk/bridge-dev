import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createFixtures,activateFixtures,preflightFixtures,cleanupFixtures} from './fixtures.mjs';
import {acceptGateway} from './client.mjs';
const [mode,release,envFile,pid,planFile]=process.argv.slice(2);
const invariant=(value,message)=>{if(!value)throw Error(message);};
const hash=b=>createHash('sha256').update(b).digest('hex');
function plan(){const parent=fs.lstatSync(path.dirname(planFile));invariant(parent.uid===0&&!(parent.mode&0o022)&&!parent.isSymbolicLink(),'ACCEPTANCE_PLAN_PARENT_UNSAFE');const st=fs.lstatSync(planFile);invariant(st.isFile()&&!st.isSymbolicLink()&&st.uid===0&&(st.mode&0o077)===0,'ACCEPTANCE_PLAN_MUST_BE_ROOT_PRIVATE');return JSON.parse(fs.readFileSync(planFile));}
try{
 invariant(process.platform==='linux'&&process.getuid()===0,'Independent Linux root operator only');
 if(mode==='cleanup'){
  if(fs.existsSync(planFile))cleanupFixtures(plan());console.log(JSON.stringify({ok:true,fixtures_removed:true}));
 }else{
 const require=createRequire(path.join(release,'package.json'));
 const environment=require('dotenv').parse(fs.readFileSync(envFile));
 if(mode==='info'){
  const active=Object.fromEntries(fs.readFileSync('/proc/'+pid+'/environ').toString().split('\0').filter(v=>v.includes('=')).map(v=>[v.slice(0,v.indexOf('=')),v.slice(v.indexOf('=')+1)]));
  invariant(environment.MCP_TOKEN&&environment.ADMIN_TOKEN&&environment.MCP_TOKEN!==environment.ADMIN_TOKEN,'Independent credentials are missing');
  invariant(environment.MCP_TOKEN===active.MCP_TOKEN&&environment.ADMIN_TOKEN===active.ADMIN_TOKEN,'Environment file credentials differ from the active service');
  const managedLocks=[path.join(environment.BRIDGEDEV_STATE_DIR||path.join(environment.HOME||active.HOME,'.bridge-dev','state'),'extensions/user/lock.json'),path.join((environment.WORKSPACE_PATH||active.WORKSPACE_PATH).split(';')[0],'.bridge-dev/managed/lock.json')];
  for(const filename of managedLocks)if(fs.existsSync(filename)){
   const info=fs.lstatSync(filename);invariant(info.isFile()&&!info.isSymbolicLink()&&info.size<16*1048576,'Unsafe managed extension lock');
   const lock=JSON.parse(fs.readFileSync(filename));invariant(lock.version===1&&Array.isArray(lock.entries),'Invalid managed extension lock');
   invariant(!lock.entries.some(entry=>entry.component?.kind==='mcp'),'Managed MCP entries require review before this empty-registry cutover');
  }
  const allowed=['HOST','PORT','ADMIN_PORT','POLICYGATE_POLICY_FILE','MCP_UPSTREAM_CONFIG','POLICYGATE_APPROVAL_PUBLIC_KEY','POLICYGATE_OPERATOR_PRIVATE_KEY','POLICYGATE_AUDIT_ANCHOR_FILE','LOCAL_CODER_CHEZMOI_SOURCE_DIR','WORKSPACE_PATH'];
  console.log(JSON.stringify({ok:true,credentials_match:true,paths:Object.fromEntries(allowed.filter(k=>environment[k]).map(k=>[k,environment[k]]))}));
 }else if(mode==='audit'){
  const policy=JSON.parse(fs.readFileSync(environment.POLICYGATE_POLICY_FILE));
  const {verifyAuditFile}=await import(pathToFileURL(path.join(release,'dist/lib/hash-audit.js')));
  const verified=verifyAuditFile(policy.audit_log),anchor=JSON.parse(fs.readFileSync(environment.POLICYGATE_AUDIT_ANCHOR_FILE));
  invariant(Number.isSafeInteger(anchor.entries)&&anchor.entries>=0&&anchor.entries<=verified.entries,'Audit anchor entry count is invalid');
  const snapshot=fs.readFileSync(policy.audit_log).subarray(0,verified.bytes),lines=snapshot.toString().trimEnd().split('\n');
  const anchored=anchor.entries===0?'0'.repeat(64):JSON.parse(lines[anchor.entries-1]).hash;
  invariant(anchor.last_hash===anchored,'Audit anchor does not match the chain');
  console.log(JSON.stringify({ok:true,...verified,prefix_sha256:hash(snapshot),anchor_entries:anchor.entries}));
 }else if(mode==='fixtures'){
  invariant(!fs.existsSync(planFile),'ACCEPTANCE_PLAN_ALREADY_EXISTS');
  const status=fs.readFileSync('/proc/'+pid+'/status','utf8'),uid=Number(status.match(/^Uid:\s+(\d+)/m)[1]),gid=Number(status.match(/^Gid:\s+(\d+)/m)[1]);
  invariant(uid!==0,'Acceptance must verify a restricted UID');
  const fixtures=createFixtures(environment.WORKSPACE_PATH.split(';')[0],uid,gid,true);
  try{
   const fd=fs.openSync(planFile,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(fixtures));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   console.log(JSON.stringify(preflightFixtures(fixtures,Number(pid))));
  }catch(error){cleanupFixtures(fixtures);throw error;}
 }else if(mode==='accept'){
  const baseline=fs.readFileSync(path.join(release,'DEPLOYED_COMMIT'),'utf8').trim()==='f909c32ca09067b869b3c51481b8db6f2aadc183';
  const fixtures=baseline?undefined:activateFixtures(plan());
  if(fixtures)fs.writeFileSync(planFile,JSON.stringify(fixtures));
  const preflight=fixtures?preflightFixtures(fixtures,Number(pid)):undefined;
  const inventory=JSON.parse(fs.readFileSync(path.join(release,'profiles/native-tool-counts.json'))).tools.slim;
  const result=await acceptGateway({url:'http://127.0.0.1:'+environment.PORT+'/mcp',adminUrl:'http://127.0.0.1:'+environment.ADMIN_PORT,mcpToken:environment.MCP_TOKEN,adminToken:environment.ADMIN_TOKEN,fixtures,inventory,baseline});
  console.log(JSON.stringify({...result,fixture_preflight:preflight}));
 }else throw Error('Unknown operator operation');
 }
}catch(error){console.error(JSON.stringify(error.acceptance||{ok:false,error:error.message}));process.exitCode=1;}
