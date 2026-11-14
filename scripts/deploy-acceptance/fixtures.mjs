import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const clean=home=>({PATH:process.env.PATH||'/usr/bin:/bin',HOME:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
function assert(ok,message){if(!ok)throw Error(message);}
function directories(root){const out=[root];for(const entry of fs.readdirSync(root,{withFileTypes:true}))if(entry.isDirectory())out.push(...directories(path.join(root,entry.name)));return out;}
export function createFixtures(workspace,uid=process.getuid?.(),gid=process.getgid?.(),deferred=false){
 workspace=fs.realpathSync(workspace);const plan={version:1,workspace,uid,gid,createdParents:[],files:[]};
 try{
  plan.repo=fs.mkdtempSync(path.join(workspace,'bridge-acceptance-'));fs.chmodSync(plan.repo,0o755);
  fs.writeFileSync(path.join(plan.repo,'visible.txt'),'read acceptance fixture\n');fs.writeFileSync(path.join(plan.repo,'AGENTS.md'),'# Disposable read fixture\n');
  for(const args of [['init','-q',plan.repo],['-C',plan.repo,'add','.'],['-C',plan.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]){
   const result=spawnSync('git',args,{env:clean(plan.repo),encoding:'utf8',timeout:10000});assert(result.status===0,'ACCEPTANCE_FIXTURE_GIT_SETUP_FAILED');
  }
  for(const name of ['.agents','.agents/skills']){
   const p=path.join(workspace,name);if(!fs.existsSync(p)){fs.mkdirSync(p);fs.chmodSync(p,0o755);plan.createdParents.push(p);}
   const st=fs.lstatSync(p);assert(st.isDirectory()&&!st.isSymbolicLink()&&!(st.mode&0o002),'ACCEPTANCE_FIXTURE_UNSAFE_PARENT');
  }
  plan.skillDirectory=fs.mkdtempSync(path.join(workspace,'.agents/skills/bridge-acceptance-'));plan.skillName=path.basename(plan.skillDirectory);
  plan.skillFile=path.join(plan.skillDirectory,deferred?'SKILL.md.pending':'SKILL.md');
  fs.writeFileSync(plan.skillFile,'---\nname: '+plan.skillName+'\ndescription: Disposable read acceptance fixture\n---\nRead only.\n');
  for(const root of [plan.repo,plan.skillDirectory]){
   const owner=root===plan.skillDirectory&&process.getuid?.()===0?0:uid,ownerGroup=owner===0?0:gid;
   const dirs=directories(root);
   for(const dir of dirs)for(const name of fs.readdirSync(dir)){
    const p=path.join(dir,name),st=fs.lstatSync(p);assert(!st.isSymbolicLink(),'ACCEPTANCE_FIXTURE_UNSAFE_LINK');
    if(st.isFile()){
     if(owner!==undefined&&process.platform!=='win32')fs.chownSync(p,owner,ownerGroup);fs.chmodSync(p,0o444);
     plan.files.push({path:p,label:p===plan.skillFile?'skill':p.endsWith('visible.txt')?'text':'repository',sha256:hash(fs.readFileSync(p))});
    }
   }
   for(const dir of dirs.reverse()){if(owner!==undefined&&process.platform!=='win32')fs.chownSync(dir,owner,ownerGroup);fs.chmodSync(dir,0o555);}
  }
  return plan;
 }catch(error){cleanupFixtures(plan);throw error;}
}
// Serialized into a child in the real service mount namespace. Only fixture
// labels are reported; file bytes, absolute paths and credentials are not output.
export const READ_CHECK=String.raw`
import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
const plan=JSON.parse(fs.readFileSync(0,'utf8'));
try{
 if(plan.uid!==undefined&&process.getuid?.()!==plan.uid)throw Error('ACCEPTANCE_FIXTURE_UID_MISMATCH');
 for(const file of plan.files){
  try{
   let dir=path.dirname(file.path);
   for(;;){fs.accessSync(dir,fs.constants.R_OK|fs.constants.X_OK);if(dir===path.dirname(dir))break;dir=path.dirname(dir);}
   const st=fs.lstatSync(file.path);
   if(!st.isFile()||st.isSymbolicLink()||(process.platform!=='win32'&&((st.mode&0o777)!==0o444||![0,plan.uid].includes(st.uid))))throw Error('unsafe permissions');
   fs.accessSync(file.path,fs.constants.R_OK);
   if(createHash('sha256').update(fs.readFileSync(file.path)).digest('hex')!==file.sha256)throw Error('content changed');
  }catch{throw Error('ACCEPTANCE_FIXTURE_UNREADABLE: '+file.label);}
 }
 console.log(JSON.stringify({ok:true,files:plan.files.length,uid:process.getuid?.(),mount_namespace:process.platform==='linux'?fs.readlinkSync('/proc/self/ns/mnt'):undefined}));
}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
`;
export function preflightFixtures(plan,pid){
 let command=process.execPath,args=['--input-type=module','-e',READ_CHECK];
 if(pid!==undefined){
  assert(process.platform==='linux'&&process.getuid?.()===0&&Number.isSafeInteger(Number(pid))&&Number(pid)>1,'ACCEPTANCE_FIXTURE_ROOT_AND_PID_REQUIRED');
  const status=fs.readFileSync('/proc/'+pid+'/status','utf8'),uid=Number(status.match(/^Uid:\s+(\d+)/m)?.[1]),gid=Number(status.match(/^Gid:\s+(\d+)/m)?.[1]),groups=status.match(/^Groups:\s*(.*)$/m)?.[1].trim().split(/\s+/).filter(Boolean).join(',');
  assert(uid===plan.uid&&gid===plan.gid,'ACCEPTANCE_FIXTURE_UID_MISMATCH');
  command='/usr/bin/nsenter';args=['--mount=/proc/'+pid+'/ns/mnt','--','/usr/bin/setpriv','--reuid='+uid,'--regid='+gid,...(groups?['--groups='+groups]:['--clear-groups']),'--no-new-privs','/usr/bin/node',...args];
 }
 const r=spawnSync(command,args,{env:clean(plan.workspace),input:JSON.stringify(plan),encoding:'utf8',timeout:15000});
 if(r.status!==0){let reason='ACCEPTANCE_FIXTURE_PREFLIGHT_FAILED';try{reason=JSON.parse(r.stderr.trim()).error;}catch{}throw Error(reason);}
 const result=JSON.parse(r.stdout);if(pid!==undefined)assert(result.mount_namespace===fs.readlinkSync('/proc/'+pid+'/ns/mnt'),'ACCEPTANCE_FIXTURE_NAMESPACE_MISMATCH');return result;
}
export function activateFixtures(plan){
 const pending=path.join(plan.skillDirectory,'SKILL.md.pending'),active=path.join(plan.skillDirectory,'SKILL.md');
 assert(plan.skillFile===pending||plan.skillFile===active,'ACCEPTANCE_FIXTURE_SKILL_PATH_REFUSED');
 if(plan.skillFile===pending){
  const chmod=process.getuid?.()!==0;if(chmod)fs.chmodSync(plan.skillDirectory,0o700);
  try{fs.renameSync(pending,active);plan.files.find(file=>file.path===pending).path=active;plan.skillFile=active;}finally{if(chmod)fs.chmodSync(plan.skillDirectory,0o555);}
 }
 return plan;
}
export function cleanupFixtures(plan){
 if(!plan||plan.version!==1)return;
 for(const p of [plan.skillDirectory,plan.repo].filter(Boolean)){
  const parent=p===plan.repo?plan.workspace:path.join(plan.workspace,'.agents/skills');assert(path.dirname(p)===parent&&path.basename(p).startsWith('bridge-acceptance-'),'ACCEPTANCE_FIXTURE_CLEANUP_PATH_REFUSED');
  if(!fs.existsSync(p))continue;assert(!fs.lstatSync(p).isSymbolicLink()&&fs.realpathSync(p)===p,'ACCEPTANCE_FIXTURE_CLEANUP_LINK_REFUSED');
  if(process.getuid?.()!==0)for(const dir of directories(p))fs.chmodSync(dir,0o700);fs.rmSync(p,{recursive:true,force:true});
 }
 for(const p of [...plan.createdParents].reverse())if(fs.existsSync(p)&&!fs.lstatSync(p).isSymbolicLink()&&fs.readdirSync(p).length===0)fs.rmdirSync(p);
}
