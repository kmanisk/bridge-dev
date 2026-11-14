// Invoked by the installed root controller with a protected configuration.
import fs from 'node:fs';
import {verify,createHash} from 'node:crypto';
import {readLeaseActivation,verifyLeaseActivation} from './lease-activation.mjs';
const [configFile]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(configFile));
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const key=fs.readFileSync(config.public_key);
function signed(payload,signature){return typeof signature==='string'&&verify(null,Buffer.from(JSON.stringify(payload)),key,Buffer.from(signature,'base64'));}
try {
 const lease=JSON.parse(fs.readFileSync(config.lease));
 if(lease.mode==='dangerous'&&lease.scope==='host-root-v1'&&Number.isSafeInteger(lease.expires_at)&&lease.expires_at>Date.now()&&lease.expires_at<=Date.now()+120*60_000&&typeof lease.nonce==='string'&&
   (input.operator_activation===true || verifyLeaseActivation(config.activation_file,lease,config.public_key))&&
   signed({mode:lease.mode,expires_at:lease.expires_at,nonce:lease.nonce,scope:lease.scope},lease.signature)){
   console.log(JSON.stringify({kind:'yolo',expires:lease.expires_at,nonce:lease.nonce}));process.exit(0);
 }
}catch{}
if(input.approval_id&&/^[a-f0-9]{24}$/.test(input.approval_id)&&input.kind==='exec'){
 try{
  if(readLeaseActivation(config.activation_file,config.public_key)?.mode!=='standard')throw Error();
  const request=JSON.parse(fs.readFileSync(config.approvals+'/'+input.approval_id+'.request.json'));
  const ticket=JSON.parse(fs.readFileSync(config.approvals+'/'+input.approval_id+'.used'));
  const fingerprint=createHash('sha256').update(JSON.stringify({sessionId:request.session_id,tool:request.tool,args:request.args})).digest('hex');
  const message={id:ticket.id,fingerprint:ticket.fingerprint,session_id:ticket.session_id,expires_at:ticket.expires_at};
  if(request.id!==input.approval_id||fingerprint!==request.fingerprint||ticket.fingerprint!==fingerprint||ticket.session_id!==request.session_id||ticket.expires_at!==request.expires_at||ticket.expires_at<=Date.now()||ticket.id!==fingerprint.slice(0,24)||!signed(message,ticket.signature)||
    request.tool!=='run_command'||typeof request.args.command!=='string'||!/^\s*(?:\/usr\/bin\/)?sudo\s/.test(request.args.command)||typeof request.args.working_directory!=='string'||input.cwd!==request.args.working_directory||JSON.stringify(input.argv)!==JSON.stringify(['/bin/bash','-c',request.args.command]))throw Error();
  console.log(JSON.stringify({kind:'approval',expires:Math.min(ticket.expires_at,Date.now()+120_000),nonce:ticket.id}));process.exit(0);
 }catch{}
}
console.error('CONTROLLER_AUTHORIZATION_REQUIRED: valid independent YOLO lease or exact signed command approval required');process.exit(1);
