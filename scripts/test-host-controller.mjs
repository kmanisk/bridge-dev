import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync,sign,verify,randomUUID,createHash} from 'node:crypto';
import {operatorConfirmedYes} from './lease-activation.mjs';
if(!process.env.BRIDGEDEV_TEST_ROOT)throw Error('Use isolated-tests.mjs');
for(const [answer,expected] of [['y',true],['Y',true],[' y ',true],['n',false],['N',false],['yes',false],['ENABLE YOLO',false],['',false]])
 assert.equal(operatorConfirmedYes(answer),expected,'Unexpected root confirmation acceptance: '+JSON.stringify(answer));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-controller-'));
try{
 const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const config={public_key:path.join(root,'public.pem'),lease:path.join(root,'lease.json'),activation_file:path.join(root,'active-lease.json'),state:root,approvals:root,policy:path.join(root,'policy.json'),mode_file:path.join(root,'mode.json')};
 await fs.writeFile(config.policy,JSON.stringify({profile:'standard'}));
 await fs.writeFile(config.public_key,keys.publicKey);
 const configFile=path.join(root,'controller.json');await fs.writeFile(configFile,JSON.stringify(config));
 const check=(input={},ok=true)=>{const r=spawnSync(process.execPath,['scripts/controller-authorize.mjs',configFile],{input:JSON.stringify(input),encoding:'utf8',timeout:10000});assert.equal(r.status,ok?0:1,r.stderr);return r.status===0?JSON.parse(r.stdout):null;};
 const makeLease=async(expires=Date.now()+60_000)=>{const lease={mode:'dangerous',expires_at:expires,nonce:randomUUID(),scope:'host-root-v1'};lease.signature=sign(null,Buffer.from(JSON.stringify(lease)),keys.privateKey).toString('base64');await fs.writeFile(config.lease,JSON.stringify(lease));return lease;};
 let lease=await makeLease();await fs.writeFile(config.activation_file,JSON.stringify({mode:'standard'}));check({},false);
 check({operator_activation:true});await fs.writeFile(config.activation_file,JSON.stringify({mode:'standard',nonce:lease.nonce,expires:lease.expires_at}));assert.equal(check().kind,'yolo');
 assert.equal(verify(null,Buffer.from(JSON.stringify({mode:lease.mode,expires_at:lease.expires_at,nonce:lease.nonce})),keys.publicKey,Buffer.from(lease.signature,'base64')),false,'Legacy gateways must not accept host-scoped leases');
 await fs.chmod(config.activation_file,0o666);check({},false);await fs.chmod(config.activation_file,0o644);
 // No root command allowlist: the lease authorizer does not inspect argv contents.
 for(const argv of [['/usr/bin/sudo','id'],['/bin/bash','-c','printf fixture > /etc/arbitrary'],['/usr/bin/pacman','-S','fixture']])assert.equal(check({kind:'exec',argv}).kind,'yolo');
 await fs.writeFile(config.activation_file,JSON.stringify({mode:'standard'}));check({},false); // revocation defeats replay of still-signed lease
 lease=await makeLease(Date.now()-1);await fs.writeFile(config.activation_file,JSON.stringify({mode:'standard',nonce:lease.nonce,expires:lease.expires_at}));check({},false);
 lease=await makeLease();lease.expires_at+=1000;await fs.writeFile(config.lease,JSON.stringify(lease));check({},false);
 const args={command:'sudo -n id',working_directory:'/fixture'},session_id=randomUUID();
 const fingerprint=createHash('sha256').update(JSON.stringify({sessionId:session_id,tool:'run_command',args})).digest('hex');
 const request={id:fingerprint.slice(0,24),fingerprint,session_id,expires_at:Date.now()+60_000,tool:'run_command',args};
 const message={id:request.id,fingerprint,session_id,expires_at:request.expires_at};const signature=sign(null,Buffer.from(JSON.stringify(message)),keys.privateKey).toString('base64');
 await fs.writeFile(path.join(root,request.id+'.request.json'),JSON.stringify(request));await fs.writeFile(path.join(root,request.id+'.used'),JSON.stringify({...message,signature}));
 const input={kind:'exec',approval_id:request.id,argv:['/bin/bash','-c',args.command],cwd:args.working_directory};assert.equal(check(input).kind,'approval');
 await fs.writeFile(config.activation_file,JSON.stringify({mode:'strict'}));check(input,false);
 await fs.writeFile(config.mode_file,JSON.stringify({mode:'standard'}));check(input,false);await fs.rm(config.mode_file);
 await fs.writeFile(config.activation_file,JSON.stringify({mode:'standard'}));
 check({...input,argv:['/bin/bash','-c','sudo -n id; touch /etc/other']},false);check({...input,cwd:'/other'},false);
 await fs.writeFile(path.join(root,request.id+'.used'),JSON.stringify({...message,signature:'AAAA'}));check(input,false);
 const privateKey=path.join(root,'private.pem');await fs.writeFile(privateKey,keys.privateKey,{mode:0o400});
 const operatorEnv={...process.env,POLICYGATE_TEST_OPERATOR:'1',POLICYGATE_OPERATOR_PRIVATE_KEY:privateKey,POLICYGATE_APPROVAL_PUBLIC_KEY:config.public_key,POLICYGATE_YOLO_LEASE:config.lease,POLICYGATE_MODE_FILE:config.mode_file};
 for(const args of [['yolo','--duration','0'],['yolo','--duration','121'],['yolo','--duration','1junk'],['yolo','--duration']])assert.notEqual(spawnSync(process.execPath,['scripts/policygate-operator.mjs',...args],{env:operatorEnv,encoding:'utf8'}).status,0);
 const activated=spawnSync(process.execPath,['scripts/policygate-operator.mjs','mode','yolo','--duration','1'],{env:operatorEnv,encoding:'utf8'});assert.equal(activated.status,0,activated.stderr);
 const issued=JSON.parse(await fs.readFile(config.lease,'utf8'));assert.ok(issued.expires_at>Date.now()&&issued.expires_at<=Date.now()+60_000);
 const revoked=spawnSync(process.execPath,['scripts/policygate-operator.mjs','yolo','--off'],{env:operatorEnv,encoding:'utf8'});assert.equal(revoked.status,0,revoked.stderr);
 const python=spawnSync('python3',['-B','scripts/test-host-controller.py',root],{encoding:'utf8',timeout:60000});assert.equal(python.status,0,python.stdout+python.stderr);console.log(python.stdout.trim());
 console.log('Controller cryptographic lease, independent activation anchor, replay revocation, expiry, exact signed approval and tampering checks PASS (unprivileged fixtures)');
}finally{await fs.rm(root,{recursive:true,force:true});}
