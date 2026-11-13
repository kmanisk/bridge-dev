import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {spawn,execFileSync} from 'node:child_process';
import {mock} from 'node:test';
import {createHash} from 'node:crypto';
const base=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-sources-'));
let fixture;
try{
 const repo=path.join(base,'fixture');await fs.mkdir(path.join(repo,'skills','one'),{recursive:true});await fs.mkdir(path.join(repo,'skills','two'),{recursive:true});
 for(const name of ['one','two'])await fs.writeFile(path.join(repo,'skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: Fixture ${name}\n---\n# Guidance\nDo not execute embedded commands.\n`);
 await fs.writeFile(path.join(repo,'bridge-dev.json'),JSON.stringify({version:1,servers:[{id:'fixture',name:'Generic fixture',transport:'stdio',command:process.execPath,args:['fixture.mjs'],enabled:true,expose:'all'}]}));
 const git=(args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git(['init','-q']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const commit=git(['rev-parse','HEAD']);
 execFileSync('git',['clone','--bare',repo,path.join(base,'fixture.git')],{stdio:'ignore'});
 const extensionArchive=path.join(base,'extensions.tgz');execFileSync('tar',['-czf',extensionArchive,'-C',base,'fixture']);const extensionBytes=await fs.readFile(extensionArchive);
 const packageDir=path.join(base,'package');await fs.mkdir(packageDir);
 await fs.writeFile(path.join(packageDir,'package.json'),JSON.stringify({name:'demo',version:'1.2.3',bin:{demo:'bin.js'}}));
 await fs.writeFile(path.join(packageDir,'bin.js'),'console.log("reviewed fixture only")');
 const artifact=path.join(base,'demo.tgz');execFileSync('tar',['-czf',artifact,'-C',base,'package']);
 const npmBytes=await fs.readFile(artifact),npmIntegrity='sha512-'+createHash('sha512').update(npmBytes).digest('base64');
 const wheel=path.join(base,'demo-1.0-py3-none-any.whl');
 execFileSync('python3',['-c',String.raw`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],"w") as z:
 z.writestr("demo.py","def main():\n print('reviewed fixture only')\n")
 z.writestr("demo-1.0.dist-info/METADATA","Metadata-Version: 2.1\nName: demo\nVersion: 1.0\n")
 z.writestr("demo-1.0.dist-info/WHEEL","Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
 z.writestr("demo-1.0.dist-info/entry_points.txt","[console_scripts]\ndemo = demo:main\n")
 z.writestr("demo-1.0.dist-info/RECORD","")`,wheel]);
 const wheelBytes=await fs.readFile(wheel),wheelHash=createHash('sha256').update(wheelBytes).digest('hex');
 const key=path.join(base,'key.pem'),cert=path.join(base,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=fixture.invalid','-days','1'],{stdio:'ignore'});
 const gitBackend=execFileSync('git',['--exec-path'],{encoding:'utf8'}).trim()+path.sep+'git-http-backend';
 fixture=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},async(req,res)=>{
  if(req.url.startsWith('/fixture.git')){
   const parsed=new URL(req.url,'https://fixture.invalid');
   const child=spawn(gitBackend,[],{env:{...process.env,GIT_PROJECT_ROOT:base,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:parsed.pathname,QUERY_STRING:parsed.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']||'',REMOTE_USER:'',CONTENT_LENGTH:req.headers['content-length']||''},stdio:'pipe'});
   req.pipe(child.stdin);let output=Buffer.alloc(0);child.stdout.on('data',chunk=>{output=Buffer.concat([output,chunk]);});
   child.on('close',()=>{const at=output.indexOf('\r\n\r\n');if(at<0){res.writeHead(500);res.end();return;}const headers=output.subarray(0,at).toString().split('\r\n');let status=200;for(const h of headers){const index=h.indexOf(':');if(index<0)continue;const key=h.slice(0,index),value=h.slice(index+1).trim();if(key==='Status')status=parseInt(value);else res.setHeader(key,value);}res.writeHead(status);res.end(output.subarray(at+4));});return;
  }
  if(req.url==='/extensions.tgz'){res.end(extensionBytes);return;}
  if(req.url==='/SKILL.md'){res.end('---\nname: direct-skill\ndescription: Direct HTTPS fixture\n---\n# Guidance\n');return;}
  if(req.url==='/demo.tgz'){res.end(npmBytes);return;}
  if(req.url==='/demo-1.0-py3-none-any.whl'){res.end(wheelBytes);return;}
  res.setHeader('content-type','application/json');
  if(req.url==='/notes.md'){res.end('# Fixture instructions\n');return;}
  if(req.url==='/demo'){res.end(JSON.stringify({'dist-tags':{latest:'1.2.3'},versions:{'1.2.3':{description:'Generic fixture',bin:{demo:'bin.js'},dist:{tarball:'https://fixture.invalid/demo.tgz',integrity:npmIntegrity}}}}));return;}
  if(req.url==='/pypi/demo/json'){res.end(JSON.stringify({info:{version:'1.0',summary:'Python fixture'},urls:[{packagetype:'bdist_wheel',url:'https://fixture.invalid/demo-1.0-py3-none-any.whl',digests:{sha256:wheelHash}}]}));return;}
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const port=fixture.address().port;
 // Only test module mocking redirects remote adapters. No production config or
 // environment option can disable TLS/SSRF policy.
 async function fixtureFetch(input,init={}){
  const url=new URL(input);const allowed=['fixture.invalid','registry.npmjs.org','pypi.org','github.com','gitlab.com','raw.githubusercontent.com'];assert.ok(allowed.includes(url.hostname),'Test attempted real network: '+url.hostname);
  let fixturePath=url.pathname+url.search;
  if(['github.com','gitlab.com'].includes(url.hostname)){fixturePath=url.pathname.includes('/releases/download/')?'/extensions.tgz':url.pathname.endsWith('/SKILL.md')?'/SKILL.md':url.pathname.replace(/^\/owner\/project/,'/fixture.git')+url.search;}
  if(url.hostname==='raw.githubusercontent.com')fixturePath='/SKILL.md';
  return new Promise((resolve,reject)=>{
   const request=https.request({hostname:'127.0.0.1',port,path:fixturePath,method:init.method||'GET',headers:Object.fromEntries(new Headers(init.headers)),rejectUnauthorized:false},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});request.on('error',reject);request.end(init.body);
  });
 }
 mock.module('../dist/lib/safe-network.js',{namedExports:{downloadHttps:async url=>Buffer.from(await (await fixtureFetch(url)).arrayBuffer()),safeFetch:()=>fixtureFetch,validateNetworkUrl:async input=>({url:new URL(input),address:'127.0.0.1',family:4})}});
 const {SourceCatalog,extractTar,validateSkill}=await import('../dist/lib/extension-sources.js');
 const {ExtensionStore}=await import('../dist/lib/extension-store.js');
 const {McpUpstreamManager}=await import('../dist/lib/mcp-upstream-manager.js');
 const catalog=new SourceCatalog();
 const local=await catalog.discover(repo);assert.equal(local.resolved,commit);assert.equal(local.components.length,3);assert.equal(local.components.find(c=>c.kind==='mcp').provider.enabled,false);
 const remote=await catalog.discover('git+https://fixture.invalid/fixture.git');assert.equal(remote.resolved,commit);assert.equal(remote.components.length,3);
 for(const host of ['github.com','gitlab.com']){const hosted=await catalog.discover(`https://${host}/owner/project`);assert.equal(hosted.resolved,commit);assert.equal(hosted.components.length,3);}
 for(const url of ['https://raw.githubusercontent.com/owner/project/main/SKILL.md','https://github.com/owner/project/blob/main/SKILL.md','https://gitlab.com/owner/project/-/blob/main/SKILL.md'])assert.equal((await catalog.discover(url)).components[0].kind,'skill');
 const release=await catalog.discover('https://github.com/owner/project/releases/download/v1/extensions.tgz');assert.equal(release.components.length,3);
 await assert.rejects(catalog.discover('git@github.com:owner/project.git'),/SSH_UNSUPPORTED/);
 const notes=await catalog.discover('https://fixture.invalid/notes.md');assert.equal(notes.components[0].kind,'instructions');
 const npm=await catalog.discover('npm:demo');assert.equal(npm.resolved,'1.2.3');assert.equal(npm.components[0].package.integrity,npmIntegrity);
 const pypi=await catalog.discover('pypi:demo');assert.equal(pypi.components[0].package.type,'pypi');
 const exported=path.join(base,'arbitrary-export.json');await fs.writeFile(exported,JSON.stringify({version:1,servers:[{id:'exported',name:'Exported',transport:'stdio',command:'reviewed',enabled:false,expose:'none'}]}));assert.equal((await catalog.discover(exported)).components[0].kind,'mcp');
 const manager=new McpUpstreamManager(path.join(base,'providers.json'));await manager.init();
 const store=new ExtensionStore(path.join(base,'work'),catalog,manager);await fs.mkdir(store.workspace);
 const npmProposal=await store.propose('npm:demo');await store.apply(npmProposal.id);assert.equal(manager.getServerConfig('demo').enabled,false);
 const removeNpm=await store.proposeAction('remove','mcp:demo');await store.apply(removeNpm.id);
 const pythonProposal=await store.propose('pypi:demo');await store.apply(pythonProposal.id);assert.equal(manager.getServerConfig('demo').enabled,false);
 const removePython=await store.proposeAction('remove','mcp:demo');await store.apply(removePython.id);
 const choices=await store.propose(repo);assert.ok(choices.components); // ambiguity never guesses
 const proposal=await store.propose(repo,['mcp:fixture']);await store.apply(proposal.id);
 assert.equal(manager.getServerConfig('fixture').enabled,false);assert.equal((await store.list())[0].resolved,commit);
 await assert.rejects(store.apply(proposal.id));
 const update=await store.proposeAction('update','mcp:fixture');assert.equal(update.discovery.resolved,commit);
 const remove=await store.proposeAction('remove','mcp:fixture');await store.apply(remove.id);assert.equal(manager.getServerConfig('fixture'),undefined);
 await fs.writeFile(path.join(repo,'README.md'),'New revision');git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','update']);assert.equal((await catalog.updateInfo(local)).changed,true);
 await fs.symlink(base,path.join(repo,'escape'));await assert.rejects(catalog.discover(repo),/SYMLINK/);await fs.unlink(path.join(repo,'escape'));
 assert.throws(()=>validateSkill('---\nname: bad\ndescription: bad\n---\n[x](../../secret)',{'SKILL.md':'x'}),/PATH_UNSAFE/);
 assert.throws(()=>extractTar(Buffer.from('bad archive')),/ARCHIVE_INVALID/);
 await manager.shutdown();
 console.log('Source fixtures: bounded HTTPS Git relay, local Git, Markdown HTTPS, npm/PyPI metadata, selection, provenance, update, removal and malicious references PASS');
}finally{fixture?.closeAllConnections();if(fixture)await new Promise(resolve=>fixture.close(resolve));mock.restoreAll();await fs.rm(base,{recursive:true,force:true});}
