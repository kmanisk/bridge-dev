import fs from 'node:fs';
import path from 'node:path';

// The deployment's policy/public-key owner is the activation authority. In the
// hardened installation that is root; isolated fixtures own their own policy.
// User-facing Full System prompt defaults to Yes on explicit Enter.
// No input object/EOF/cancel and any nonempty answer other than 'y' decline.
export function operatorConfirmedYes(answer){
 if(typeof answer!=='string')return false;
 const normalized=answer.trim().toLowerCase();
 return normalized===''||normalized==='y';
}

export function isPermanentLease(lease){
 return lease?.mode==='dangerous'&&lease.scope==='host-root-v1'&&lease.lifetime==='until_off'&&
   lease.expires_at===null&&typeof lease.nonce==='string'&&lease.nonce.length>0;
}
export function isActiveLease(lease,now=Date.now()){
 if(isPermanentLease(lease))return true;
 return lease?.mode==='dangerous'&&lease.scope==='host-root-v1'&&lease.lifetime===undefined&&
   Number.isSafeInteger(lease.expires_at)&&lease.expires_at>now&&lease.expires_at<=now+120*60_000&&
   typeof lease.nonce==='string'&&lease.nonce.length>0;
}

export function readLeaseActivation(filename,authorityFile){
 try{
  const authority=fs.lstatSync(authorityFile),file=fs.lstatSync(filename),parent=fs.lstatSync(path.dirname(filename));
  if(!authority.isFile()||authority.isSymbolicLink()||(authority.mode&0o022)||!file.isFile()||file.isSymbolicLink()||file.size>4096||
    !parent.isDirectory()||parent.isSymbolicLink()||file.uid!==authority.uid||parent.uid!==authority.uid||(file.mode&0o022)||(parent.mode&0o022))return null;
  const value=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(!value||!['strict','standard'].includes(value.mode))return null;
  if(value.nonce!==undefined){
   if(typeof value.nonce!=='string'||!value.nonce.length||value.nonce.length>128)return null;
   if(value.lifetime==='until_off'){if(value.expires!==null)return null;}
   else if(value.lifetime!==undefined||!Number.isSafeInteger(value.expires))return null;
  }else if(value.expires!==undefined||value.lifetime!==undefined)return null;
  return value;
 }catch{return null;}
}
export function verifyLeaseActivation(filename,lease,authorityFile){
 const value=readLeaseActivation(filename,authorityFile);
 return Boolean(value&&isActiveLease(lease)&&value.nonce===lease.nonce&&
    value.expires===lease.expires_at&&value.lifetime===lease.lifetime);
}
