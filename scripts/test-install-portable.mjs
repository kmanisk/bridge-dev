#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-installer-fixture-'));
try{
  const source=path.join(tmp,'source'),install=path.join(tmp,'install'),
    config=path.join(tmp,'config'),bin=path.join(tmp,'bin');
  fs.mkdirSync(path.join(source,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(source,'src'),{recursive:true});
  for(const filename of ['src/index.ts','src/cli.ts','tsconfig.json'])
    fs.writeFileSync(path.join(source,filename),'test fixture');
  fs.copyFileSync(path.join(root,'scripts','install-portable.mjs'),path.join(source,'scripts','install-portable.mjs'));
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({
    name:'bridge-dev',version:'0.0.0-fixture',private:true,type:'module',
    scripts:{build:'node scripts/build-fixture.mjs'}
  }));
  fs.writeFileSync(path.join(source,'scripts','build-fixture.mjs'),
    "import fs from 'node:fs';fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/cli.js','console.log(\"fixture:\"+process.argv[2]);');");
  const env={...process.env,BRIDGEDEV_INSTALL_TEST_ROOT:'1',
    BRIDGEDEV_INSTALL_ROOT:install,BRIDGEDEV_INSTALL_CONFIG:config,
    BRIDGEDEV_INSTALL_BIN:bin,BRIDGEDEV_INSTALL_WORKSPACE:path.join(tmp,'workspace')};
  const run=flags=>spawnSync(process.execPath,[path.join(root,'scripts','install-portable.mjs'),'--source',source,...flags],
    {cwd:tmp,env,encoding:'utf8',timeout:90000});
  let result=run(['--dry-run']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).writes,false);
  assert.ok(!fs.existsSync(install),'Dry-run changed the filesystem');
  result=run([]);
  assert.equal(result.status,0,(result.stdout+'\n'+result.stderr).slice(-1800));
  assert.ok(fs.existsSync(path.join(install,'app','dist','cli.js')));
  const envPath=path.join(config,'.env'),initial=fs.readFileSync(envPath,'utf8');
  const mcp=initial.match(/MCP_TOKEN="([0-9a-f]{64})"/);
  const admin=initial.match(/ADMIN_TOKEN="([0-9a-f]{64})"/);
  assert.ok(mcp&&admin&&mcp[1]!==admin[1]);
  assert.match(initial,/HOST="127\.0\.0\.1"/);
  if(process.platform==='win32'){
    assert.ok(fs.existsSync(path.join(bin,'bridge-dev.cmd')));
  }else{
    assert.equal(fs.statSync(envPath).mode&0o777,0o600);
    const wrapper=path.join(bin,'bridge-dev');
    assert.ok(fs.existsSync(wrapper));
    result=spawnSync(wrapper,['help'],{env,encoding:'utf8',timeout:9000});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/fixture:help/);
  }
  result=run([]);
  assert.equal(result.status,0,(result.stdout+'\n'+result.stderr).slice(-1800));
  assert.equal(fs.readFileSync(envPath,'utf8'),initial,'Reinstall rotated private credentials');
  assert.ok(fs.readdirSync(install).some(f=>f.startsWith('app.previous-')),'Previous version was lost');
  assert.ok(!fs.readdirSync(install).some(f=>f.startsWith('.stage-')),'Staging files remain');
  console.log('BridgeDev one-command installer: PASS');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}