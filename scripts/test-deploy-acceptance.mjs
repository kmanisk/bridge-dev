import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createFixtures,activateFixtures,preflightFixtures,cleanupFixtures} from './deploy-acceptance/fixtures.mjs';
import {acceptGateway} from './deploy-acceptance/client.mjs';
import {fixturePorts} from './test-ports.mjs';
import {loadProjectSkill,loadProjectSkills} from '../dist/lib/skills-loader.js';
import {readFileSafe} from '../dist/lib/sudo-fs.js';
import {readSystemDocument} from '../dist/lib/system-context.js';
if(!process.env.BRIDGEDEV_TEST_ROOT)throw Error('Use isolated-tests.mjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-acceptance-test-')),work=path.join(root,'work');fs.mkdirSync(work);let plan,gateway,logs='';
const [port,adminPort]=await fixturePorts(2),token=randomBytes(32).toString('hex'),admin=randomBytes(32).toString('hex');
const policy=JSON.parse(fs.readFileSync(process.env.POLICYGATE_POLICY_FILE));Object.assign(policy,{profile:'standard',writable_roots:[work],protected_paths:[],secret_paths:[],hard_paths:[],approval_paths:[],audit_log:path.join(root,'audit.jsonl')});
const pf=path.join(root,'policy.json');fs.writeFileSync(pf,JSON.stringify(policy));const providerFile=path.join(root,'providers.json');fs.writeFileSync(providerFile,JSON.stringify({version:1,servers:[]}));
const env={...process.env,POLICYGATE_POLICY_FILE:pf,BRIDGEDEV_RUNTIME_MODE:'managed',WORKSPACE_PATH:work,BRIDGEDEV_STATE_DIR:path.join(root,'state'),MCP_UPSTREAM_CONFIG:providerFile,HOST:'127.0.0.1',PORT:String(port),ADMIN_PORT:String(adminPort),MCP_TOKEN:token,ADMIN_TOKEN:admin,CHATGPT_TOOL_PROFILE:'slim'};
try{
 const mask=process.umask(0o077);try{plan=createFixtures(work);}finally{process.umask(mask);}
 assert.ok(preflightFixtures(plan).ok);
 if(process.platform!=='win32'){
  for(const file of plan.files)assert.equal(fs.statSync(file.path).mode&0o777,0o444);
  for(const dir of plan.createdParents)assert.equal(fs.statSync(dir).mode&0o777,0o755);
  const file=plan.files.find(f=>f.label==='skill');fs.chmodSync(file.path,0o600);assert.throws(()=>preflightFixtures(plan),/ACCEPTANCE_FIXTURE_UNREADABLE: skill/);fs.chmodSync(file.path,0o444);assert.ok(preflightFixtures(plan).ok);
 }
 const deferred=createFixtures(work,process.getuid?.(),process.getgid?.(),true);
 try{assert.ok(preflightFixtures(deferred).ok);assert.equal((await loadProjectSkills(work)).some(s=>s.name===deferred.skillName),false);activateFixtures(deferred);assert.match((await loadProjectSkill(work,deferred.skillName)).content,/Read only/);assert.ok(preflightFixtures(deferred).ok);}finally{cleanupFixtures(deferred);}
 // Inject only fixture-path permission errors. No production file is accessed.
 const original=fsp.readFile;const skillFile=path.join(plan.skillDirectory,'SKILL.md');
 fsp.readFile=async function(file,...args){if(String(file)===skillFile)throw Object.assign(Error('private fixture path should not leak'),{code:'EACCES'});return original.call(this,file,...args);};
 try{await assert.rejects(loadProjectSkill(work,plan.skillName),error=>/SKILL_PERMISSION_DENIED/.test(error.message)&&!error.message.includes(root));await assert.rejects(readFileSafe(skillFile),error=>/FILE_PERMISSION_DENIED/.test(error.message)&&!error.message.includes(root));}finally{fsp.readFile=original;}
 assert.match((await loadProjectSkill(work,plan.skillName)).content,/Read only/);
 const contextFile=policy.context_files[0];fsp.readFile=async function(file,...args){if(String(file)===contextFile)throw Object.assign(Error('private path must not leak'),{code:'EPERM'});return original.call(this,file,...args);};
 try{const doc=await readSystemDocument('agents');assert.match(doc.error,/DOCUMENT_PERMISSION_DENIED/);assert.ok(!doc.error.includes(path.dirname(contextFile)));}finally{fsp.readFile=original;}
 gateway=spawn(process.execPath,['dist/index.js'],{env,stdio:['ignore','pipe','pipe']});gateway.stdout.on('data',b=>logs+=b);gateway.stderr.on('data',b=>logs+=b);
 let ready=false;for(let i=0;i<150;i++){if(gateway.exitCode!==null)throw Error(logs);try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,'Gateway startup deadline');
 const result=await acceptGateway({url:`http://127.0.0.1:${port}/mcp`,adminUrl:`http://127.0.0.1:${adminPort}`,mcpToken:token,adminToken:admin,fixtures:plan,inventory:JSON.parse(fs.readFileSync('profiles/native-tool-counts.json')).tools.slim});
 assert.ok(result.ok&&result.checks.all_read_output_schemas);assert.equal(result.reads.load_skill,'schema-valid structured result');assert.equal(result.reads.skills_validate,'schema-valid structured result');
 console.log('Versioned acceptance: UMask=0077, explicit read-only fixtures/parents, negative preflight, non-leaky skill/document errors, real HTTP SDK all-read contracts, sessions, denials and admin authentication PASS');
}finally{
 if(gateway&&gateway.exitCode===null){const exit=new Promise(r=>gateway.once('exit',r));try{await fetch(`http://127.0.0.1:${adminPort}/api/lifecycle/stop`,{method:'POST',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:'{}'});}catch{gateway.kill();}await Promise.race([exit,new Promise(r=>setTimeout(r,2000))]);if(gateway.exitCode===null)gateway.kill('SIGKILL');await exit;}
 if(plan){cleanupFixtures(plan);cleanupFixtures(plan);}fs.rmSync(root,{recursive:true,force:true});
}
