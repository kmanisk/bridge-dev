import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {gzipSync} from 'node:zlib';
import {extractTar,validateSkill,safeRelative} from '../dist/lib/extension-sources.js';
import {extractZip} from '../dist/lib/safe-zip.js';
import {ExtensionStore} from '../dist/lib/extension-store.js';
import {atomicJson,withFileLock} from '../dist/lib/atomic-store.js';
import {isPublicAddress,validateNetworkUrl} from '../dist/lib/safe-network.js';
import {validateToolMetadata,sanitizeProviderResult,cleanProviderText} from '../dist/lib/provider-security.js';
import {publicProvider} from '../dist/lib/provider-redaction.js';
import {childEnvironment} from '../dist/lib/child-environment.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-security-'));
function tar(name,type='0',body=Buffer.from('safe')){
 const header=Buffer.alloc(512);header.write(name,0,100,'utf8');header.write('0000644\0',100);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header.fill(32,148,156);header.write(type,156);header.write('ustar\0',257);let sum=0;for(const n of header)sum+=n;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
 return Buffer.concat([header,body,Buffer.alloc((512-body.length%512)%512),Buffer.alloc(1024)]);
}
try{
 for(const name of ['../escape','/absolute','C:/absolute','x/../../escape','x/../y','__proto__/x'])assert.throws(()=>safeRelative(name));
 for(const name of ['../escape','/absolute','C:/absolute'])assert.throws(()=>extractTar(tar(name)),/UNSAFE/);
 for(const type of ['1','2','3','6','x','L'])assert.throws(()=>extractTar(tar('safe',type)),/REFUSED/);
 assert.throws(()=>extractTar(gzipSync(Buffer.alloc(17*1048576))),/large|size|buffer|length|limit/i);
 assert.throws(()=>extractZip(Buffer.from('invalid zip')),/INVALID/);
 const zipAttacks=JSON.parse(await fs.readFile(new URL('./fixtures/archive-attacks.json',import.meta.url),'utf8'));for(const [name,encoded]of Object.entries(zipAttacks))assert.throws(()=>extractZip(Buffer.from(encoded,'base64')),undefined,name);
 assert.deepEqual(Object.keys(extractTar(tar('safe.txt'))),['safe.txt']);
 for(const ip of ['0.0.0.0','127.1.2.3','10.0.0.1','100.64.0.1','169.254.169.254','172.31.0.1','192.168.0.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','64:ff9b::7f00:1'])assert.equal(isPublicAddress(ip),false,ip);
 assert.equal(isPublicAddress('2001:4860:4860::8888'),true);assert.equal(isPublicAddress('2001:0db8::1'),false);
 for(const url of ['https://127.0.0.1','https://[::1]','https://0x7f000001','http://8.8.8.8','https://user:pass@8.8.8.8'])await assert.rejects(validateNetworkUrl(url));
 assert.throws(()=>validateSkill('---\nname: bad\ndescription: bad\n---\n[x](file:///secret)',{'SKILL.md':'x'}),/LINK_UNSAFE/);
 assert.throws(()=>validateToolMetadata([{name:'bad',inputSchema:{type:'object',properties:{x:{$ref:'https://evil.invalid'}}}}]),/UNSUPPORTED/);
 assert.throws(()=>sanitizeProviderResult({content:[{type:'text',text:'x'.repeat(5*1048576)}]},'p'),/SIZE_LIMIT/);
 assert.equal(cleanProviderText('Safe\x1b\u202eText'),'SafeText');
 const env=childEnvironment({PATH:'/safe',HOME:root,ADMIN_TOKEN:'never',MCP_TOKEN:'never',POLICYGATE_OPERATOR_PRIVATE_KEY:'never',BRIDGEDEV_ADMIN_TOKEN_FILE:'never',UNRELATED_SECRET:'never'});assert.deepEqual(env,{PATH:'/safe',HOME:root});
 assert.doesNotMatch(JSON.stringify(publicProvider({id:'p',name:'p',enabled:false,transport:'stdio',command:'fixture',expose:'none',env:{CUSTOM_VALUE:'private-sentinel'},headers:{Custom:'private-header'}})),/private-sentinel|private-header/);
 const victim=path.join(root,'victim');await fs.writeFile(victim,'preserved');const config=path.join(root,'config.json');await atomicJson(config,{v:1});
 if(process.platform!=='win32'){await fs.symlink(victim,config+'.bak');await atomicJson(config,{v:2});assert.equal(await fs.readFile(victim,'utf8'),'preserved');}
 let active=0,max=0;await Promise.all(Array.from({length:12},()=>withFileLock(config,async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;})));assert.equal(max,1);
 const mkdir=fs.mkdir;let ranDeniedAction=false;
 fs.mkdir=async function(directory,...args){if(directory===config+'.lock')throw Object.assign(Error('fixture access denied'),{code:'EPERM'});return mkdir.call(this,directory,...args);};
 try{await assert.rejects(withFileLock(config,async()=>{ranDeniedAction=true;}),error=>error.code==='EPERM');assert.equal(ranDeniedAction,false);}finally{fs.mkdir=mkdir;}
 if(process.platform==='win32'){
  let transient=true,entered=false;fs.mkdir=async function(directory,...args){if(directory===config+'.lock'&&transient){transient=false;throw Object.assign(Error('fixture directory deletion pending'),{code:'EPERM'});}return mkdir.call(this,directory,...args);};
  try{await withFileLock(config,async()=>{entered=true;});assert.equal(entered,true);}finally{fs.mkdir=mkdir;}
 }
 const work=path.join(root,'work');await fs.mkdir(work);const md=path.join(root,'guide.md');await fs.writeFile(md,'# Untrusted fixture guidance');const store=new ExtensionStore(work);
 const proposals=await Promise.all([store.propose(md),store.propose(md)]);const applied=await Promise.allSettled(proposals.map(p=>store.apply(p.id)));assert.equal(applied.filter(r=>r.status==='fulfilled').length,1);
 const key='instructions:guide',remove=await store.proposeAction('remove',key);const file=path.join(store.root,'proposals',remove.id+'.json');const data=JSON.parse(await fs.readFile(file,'utf8'));data.action='enable';await fs.writeFile(file,JSON.stringify(data));await assert.rejects(store.apply(remove.id),/CHANGED/);
 await fs.writeFile(path.join(store.scopeRoot('project'),'lock.json'),'{corrupt');await assert.rejects(store.list());
 console.log('Extension security: SSRF/IP forms, archive links/traversal/bombs, untrusted schemas, limits, credential scrub, symlink-safe backups, locks, races, tampering and corruption PASS');
}finally{await fs.rm(root,{recursive:true,force:true});}
