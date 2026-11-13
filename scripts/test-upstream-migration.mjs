import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadUpstreamConfig,loadUpstreamConfigDetails,saveUpstreamConfig,parseUpstreamConfig} from '../dist/lib/mcp-upstream-config.js';
import {migrateUpstreamConfig,verifyRegistryBackup} from '../dist/lib/mcp-upstream-migration.js';
import {McpUpstreamManager} from '../dist/lib/mcp-upstream-manager.js';
if(!process.env.BRIDGEDEV_TEST_ROOT)throw Error('Use isolated-tests.mjs');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-registry-regression-')),file=path.join(root,'registry.json');
const put=value=>fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));
const reviewed={id:'read',name:'Reviewed fixture',transport:'http',url:'https://example.invalid/mcp?setting=retained',enabled:true,reviewed:true,expose:'allowlist',tools:['read'],disabled_tools:['write'],tool_permissions:{read:'R',write:'X'},auth:{type:'oauth',scope:'read:fixtures'},headers:{'X-Fixture':'synthetic-secret-header'},bearer_token_env_var:'SYNTHETIC_API_KEY',allow_private_network:false,idle_timeout_sec:25};
const unreviewed={id:'exec',transport:'stdio',command:process.execPath,args:['fixture.mjs','--literal'],env:{CUSTOM:'synthetic-secret-env'},enabled:true,expose:'all',tool_permissions:{echo:'X'}};
try{
 assert.equal((await loadUpstreamConfigDetails(file)).source_schema,'missing');
 for(const text of ['', '   ', '{"servers":', '{"version":99,"servers":[]}', 'null','[]','{"providers":[]}', '{"version":1,"servers":[{"id":"x","transport":"http","url":"synthetic-secret-url"}]}']){await put(text);await assert.rejects(loadUpstreamConfig(file),/UPSTREAM_/);await assert.rejects(migrateUpstreamConfig(file),/UPSTREAM_/);assert.equal(await fs.readFile(file,'utf8'),text);}
 await put({version:1,servers:[]});assert.deepEqual(await loadUpstreamConfig(file),{version:1,servers:[]});assert.equal((await migrateUpstreamConfig(file)).changed,false);
 await put({servers:[]});const emptyBytes=await fs.readFile(file),loaded=await loadUpstreamConfigDetails(file);assert.equal(loaded.source_schema,'legacy-unversioned');assert.equal(loaded.migration_required,true);assert.deepEqual(loaded.config.servers,[]);assert.ok((await fs.readFile(file)).equals(emptyBytes));
 const cli=spawnSync(process.execPath,['dist/cli.js','mcp','migrate','--config',file,'--dry-run','--json'],{env:process.env,encoding:'utf8',timeout:10000});assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout).data.diff,[{op:'add',path:'/version',value:1}]);assert.ok((await fs.readFile(file)).equals(emptyBytes));assert.deepEqual(await fs.readdir(root),['registry.json']);
 await put({servers:[reviewed,unreviewed,{...reviewed,id:'off',enabled:false,tool_prefix:'off'}]});const original=await fs.readFile(file);const info=await loadUpstreamConfigDetails(file);assert.equal(info.config.servers.length,3);assert.equal(info.config.servers[0].enabled,true);assert.equal(info.config.servers[1].enabled,false);assert.equal(info.config.servers[1].expose,'none');assert.equal(info.config.servers[2].enabled,false);
 for(const [index,record] of [reviewed,unreviewed].entries())for(const key of Object.keys(record).filter(k=>!['enabled','expose'].includes(k)))if(key==='env'){for(const [name,value] of Object.entries(record[key]))assert.equal(info.config.servers[index][key][name],value);}else assert.deepEqual(info.config.servers[index][key],record[key],key);
 const manager=new McpUpstreamManager(file);await manager.init();assert.equal(manager.initializationError,undefined);assert.equal(manager.configuration.migration_required,true);assert.equal(manager.listStatusesCached().length,3);await assert.rejects(manager.upsertServer(info.config.servers[0]),/MIGRATION_REQUIRED/);await manager.shutdown();
 await assert.rejects(saveUpstreamConfig(info.config,file),/MIGRATION_REQUIRED/);assert.ok((await fs.readFile(file)).equals(original));
 const preview=await migrateUpstreamConfig(file,true);assert.equal(preview.changed,true);assert.ok(!JSON.stringify(preview).includes('synthetic-secret'));assert.equal((await fs.readdir(root)).length,1);
 const migrated=await migrateUpstreamConfig(file);assert.match(migrated.backup,/\.backup-\d{4}-\d\d-\d\dT/);assert.ok((await fs.readFile(migrated.backup)).equals(original));assert.equal(await verifyRegistryBackup(migrated.backup,original),migrated.backup_sha256);const output=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(output.version,1);assert.equal(output.servers.length,3);assert.deepEqual(output.servers[0],reviewed);assert.deepEqual(output.servers[1],{...unreviewed,enabled:false,expose:'none'});
 const names=await fs.readdir(root),bytes=await fs.readFile(file);assert.equal((await migrateUpstreamConfig(file)).changed,false);assert.deepEqual(await fs.readdir(root),names);assert.ok((await fs.readFile(file)).equals(bytes));
 await fs.writeFile(migrated.backup,'corrupted synthetic backup');await assert.rejects(verifyRegistryBackup(migrated.backup,original),/BACKUP_VERIFICATION_FAILED/);
 for(const invalid of [{...reviewed,transport:'unsupported'},{...reviewed,auth:{type:'secret-invalid-mode'}},{...unreviewed,args:'not-an-array'},{...unreviewed,enabled:'true'},{...unreviewed,args:null},{...reviewed,expose:false},{...reviewed,permission_typo:'secret-unknown-field'}]){await put({servers:[reviewed,invalid]});const before=await fs.readFile(file);await assert.rejects(migrateUpstreamConfig(file));assert.ok((await fs.readFile(file)).equals(before));}
 await put('{"servers": [{"password": "synthetic-secret-value"}, garbage]}');try{await loadUpstreamConfig(file);assert.fail('Must reject');}catch(error){assert.ok(!String(error).includes('synthetic-secret-value'));}
 if(process.platform!=='win32'){
  await put({servers:[]});await fs.chmod(file,0o444);assert.equal((await loadUpstreamConfigDetails(file)).migration_required,true);await assert.rejects(migrateUpstreamConfig(file),/READ_ONLY|BLOCKED/);await fs.chmod(file,0o644);
  await fs.chmod(root,0o555);try{assert.deepEqual((await loadUpstreamConfig(file)).servers,[]);await assert.rejects(migrateUpstreamConfig(file),/READ_ONLY|BLOCKED/);}finally{await fs.chmod(root,0o755);}
 }
 // Deterministic filesystem-level EROFS fault; no production bypass or mount.
 await put({servers:[]});const mkdir=fs.mkdir;
 fs.mkdir=async function(directory,...args){if(directory===file+'.lock')throw Object.assign(Error('fixture read-only filesystem'),{code:'EROFS'});return mkdir.call(this,directory,...args);};
 try{assert.equal((await loadUpstreamConfigDetails(file)).migration_required,true);await assert.rejects(migrateUpstreamConfig(file),/MIGRATION_BLOCKED: EROFS/);}finally{fs.mkdir=mkdir;}
 assert.equal(parseUpstreamConfig('{"servers":[]}').config.version,1);
 assert.ok(!(await fs.readdir(root)).some(name=>name.endsWith('.lock')||name.endsWith('.tmp')));
 console.log('Registry: empty/current/legacy/malformed/future, no provider loss, reviewed permissions, read-only load, explicit CLI migration, exact safe diff, verified backup and idempotency PASS');
}finally{await fs.chmod(root,0o755);await fs.rm(root,{recursive:true,force:true});}
