#!/usr/bin/env node
// User-scoped installer shared by Bash, PowerShell and Termux. No sudo/services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2);
const opt=name=>{const n=args.indexOf(name);return n<0?null:args[n+1];};
const source=path.resolve(opt('--source')||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const dryRun=args.includes('--dry-run');
const win=process.platform==='win32',mac=process.platform==='darwin';
const home=os.homedir();
const dataDefault=win?path.join(process.env.LOCALAPPDATA||path.join(home,'AppData','Local'),'BridgeDev'):
  mac?path.join(home,'Library','Application Support','BridgeDev'):
  path.join(process.env.XDG_DATA_HOME||path.join(home,'.local','share'),'bridge-dev');
const configDefault=win?path.join(process.env.APPDATA||path.join(home,'AppData','Roaming'),'BridgeDev'):
  mac?path.join(home,'Library','Application Support','BridgeDev','config'):
  path.join(process.env.XDG_CONFIG_HOME||path.join(home,'.config'),'bridge-dev');
const dataDir=path.resolve(process.env.BRIDGEDEV_INSTALL_ROOT||dataDefault);
const configDir=path.resolve(process.env.BRIDGEDEV_INSTALL_CONFIG||configDefault);
const binDir=path.resolve(process.env.BRIDGEDEV_INSTALL_BIN||(win?path.join(dataDir,'bin'):path.join(home,'.local','bin')));
const app=path.join(dataDir,'app'),config=path.join(configDir,'.env');
const workspace=path.resolve(process.env.BRIDGEDEV_INSTALL_WORKSPACE||path.join(home,'BridgeDevWorkspace'));
const major=Number(process.versions.node.split('.')[0]);
const fail=msg=>{console.error('BridgeDev installer: '+msg);process.exit(1);};
function safePath(p){
  if(!p||p===path.parse(p).root||p===path.resolve(home))fail('Unsafe install path: '+p);
  let part=p;
  while(part!==path.dirname(part)){
    if(fs.existsSync(part)&&fs.lstatSync(part).isSymbolicLink()){
      const nativeMacAlias=mac&&(
        (part==='/var'&&fs.realpathSync(part)==='/private/var')||
        (part==='/tmp'&&fs.realpathSync(part)==='/private/tmp')
      );
      if(!nativeMacAlias)fail('Symlinked installation path: '+part);
    }
    part=path.dirname(part);
  }
}
for(const p of [dataDir,configDir,binDir,app])safePath(p);
if(!Number.isSafeInteger(major)||major<22)fail('Node.js 22+ required.');
if(process.getuid?.()===0&&process.env.BRIDGEDEV_INSTALL_TEST_ROOT!=='1')fail('Run as a normal user, without sudo.');
const packageFile=path.join(source,'package.json');
if(!fs.existsSync(packageFile))fail('Missing package.json');
const pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
if(pkg.name!=='bridge-dev')fail('Unexpected package: '+pkg.name);
for(const p of ['src/index.ts','src/cli.ts','tsconfig.json','scripts/install-portable.mjs'])
  if(!fs.existsSync(path.join(source,p)))fail('Incomplete source: '+p);
if(dryRun){
  console.log(JSON.stringify({platform:process.platform,version:pkg.version,source,dataDir,configDir,binDir,workspace,writes:false}));
  process.exit(0);
}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const environment=()=>{
  const env={...process.env};
  for(const k of Object.keys(env))
    if(/^(POLICYGATE_|LOCAL_CODER_|MCP_|BRIDGEDEV_|WORKSPACE_|EXTRA_WORKSPACE_|ALLOWED_WORKSPACE_|ADMIN_TOKEN$|PORT$|ADMIN_PORT$|HOST$|DOTENV_CONFIG_PATH$|NODE_OPTIONS$|NODE_PATH$)/.test(k))delete env[k];
  return env;
};
function run(cmd,args,cwd){
  const out=spawnSync(cmd,args,{cwd,stdio:'inherit',shell:win,env:environment()});
  if(out.error)throw out.error;
  if(out.status!==0)throw Error(cmd+' failed with exit '+out.status);
}
function port(preferred){
  return new Promise((resolve,reject)=>{
    const s=net.createServer();
    s.once('error',()=>preferred?resolve(port(0)):reject(Error('No free loopback port')));
    s.listen(preferred||0,'127.0.0.1',()=>{
      const addr=s.address();
      s.close(error=>error?reject(error):resolve(addr.port));
    });
  });
}
function put(filename,text,mode){
  fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  const temp=filename+'.new-'+process.pid;
  fs.writeFileSync(temp,text,{mode});
  if(!win)fs.chmodSync(temp,mode);
  fs.renameSync(temp,filename);
}
function envFile(mcpPort,adminPort){
  const values={
    HOST:'127.0.0.1',PORT:String(mcpPort),ADMIN_PORT:String(adminPort),
    MCP_TOKEN:randomBytes(32).toString('hex'),ADMIN_TOKEN:randomBytes(32).toString('hex'),
    WORKSPACE_PATH:workspace.replaceAll('\\','/'),BRIDGEDEV_RUNTIME_MODE:'portable',
    BRIDGEDEV_STATE_DIR:path.join(dataDir,'state').replaceAll('\\','/'),
    CHATGPT_TOOL_PROFILE:'slim',CHECKPOINT_ENABLED:'false'
  };
  return Object.entries(values).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n';
}
let staged='',backup='';
try{
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  fs.mkdirSync(configDir,{recursive:true,mode:0o700});
  fs.mkdirSync(binDir,{recursive:true,mode:0o755});
  fs.mkdirSync(workspace,{recursive:true,mode:0o700});
  if(!fs.existsSync(config)){
    const mcpPort=await port(3000);
    let adminPort=await port(3001);
    while(adminPort===mcpPort)adminPort=await port(0);
    put(config,envFile(mcpPort,adminPort),0o600);
  }
  staged=path.join(dataDir,'.stage-'+process.pid+'-'+randomBytes(3).toString('hex'));
  fs.cpSync(source,staged,{recursive:true,filter:file=>{
    if(file===source)return true;
    const bits=path.relative(source,file).split(path.sep);
    return !bits.some(part=>['node_modules','.git','dist','.turbo','.cache'].includes(part)) &&
      !['package-lock.json','.env'].includes(bits.at(-1));
  }});
  console.log('[BridgeDev] Installing dependencies and building...');
  run(win?'npm.cmd':'npm',['install','--ignore-scripts','--no-audit','--no-fund'],staged);
  run(win?'npm.cmd':'npm',['run','build'],staged);
  run(win?'npm.cmd':'npm',['prune','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],staged);
  run(process.execPath,[path.join(staged,'dist','cli.js'),'help'],staged);
  if(fs.existsSync(app)){
    backup=path.join(dataDir,'app.previous-'+new Date().toISOString().replaceAll(/[^0-9]/g,'').slice(0,14)+'-'+randomBytes(4).toString('hex'));
    fs.renameSync(app,backup);
  }
  try{fs.renameSync(staged,app);staged='';}
  catch(error){if(backup&&fs.existsSync(backup))fs.renameSync(backup,app);throw error;}
  if(win){
    const cmd='@echo off\r\nset "DOTENV_CONFIG_PATH='+config+'"\r\nset "BRIDGEDEV_RUNTIME_MODE=portable"\r\n"'+process.execPath+'" "'+path.join(app,'dist','cli.js')+'" %*\r\n';
    put(path.join(binDir,'bridge-dev.cmd'),cmd,0o600);
  }else{
    const wrapper='#!/bin/sh\nexport DOTENV_CONFIG_PATH='+quote(config)+'\nexport BRIDGEDEV_RUNTIME_MODE=portable\nexec '+quote(process.execPath)+' '+quote(path.join(app,'dist','cli.js'))+' "$@"\n';
    put(path.join(binDir,'bridge-dev'),wrapper,0o755);
  }
  console.log('\nBridgeDev '+pkg.version+' installed.');
  console.log('Workspace: '+workspace);
  console.log('Config preserved: '+config);
  console.log('No root service or background process was installed.');
  const launcher=path.join(binDir,win?'bridge-dev.cmd':'bridge-dev');
  console.log('Start: '+launcher+' start');
  console.log('View private credentials in your terminal: '+launcher+' access');
  if(!win&&!(process.env.PATH||'').split(path.delimiter).includes(binDir))
    console.log('PATH: export PATH='+quote(binDir)+':"$PATH"');
  if(backup)console.log('Previous runtime saved: '+backup);
}catch(error){
  console.error('BridgeDev installation failed: '+String(error?.message||error));
  if(staged&&fs.existsSync(staged))fs.rmSync(staged,{recursive:true,force:true});
  process.exitCode=1;
}