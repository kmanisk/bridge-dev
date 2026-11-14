import fs from 'node:fs';
import path from 'node:path';

// The deployment's policy/public-key owner is the activation authority. In the
// hardened installation that is root; isolated fixtures own their own policy.
export function readLeaseActivation(filename,authorityFile){
 try{
  const authority=fs.lstatSync(authorityFile),file=fs.lstatSync(filename),parent=fs.lstatSync(path.dirname(filename));
  if(!authority.isFile()||authority.isSymbolicLink()||(authority.mode&0o022)||!file.isFile()||file.isSymbolicLink()||file.size>4096||
    !parent.isDirectory()||parent.isSymbolicLink()||file.uid!==authority.uid||parent.uid!==authority.uid||(file.mode&0o022)||(parent.mode&0o022))return null;
  const value=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(!value||!['strict','standard'].includes(value.mode))return null;
  if(value.nonce!==undefined&&(typeof value.nonce!=='string'||value.nonce.length>128||!Number.isSafeInteger(value.expires)))return null;
  return value;
 }catch{return null;}
}
export function verifyLeaseActivation(filename,lease,authorityFile){
 const value=readLeaseActivation(filename,authorityFile);
 return Boolean(value&&lease.scope==='host-root-v1'&&typeof lease.nonce==='string'&&lease.nonce.length&&value.nonce===lease.nonce&&value.expires===lease.expires_at&&value.expires>Date.now());
}
