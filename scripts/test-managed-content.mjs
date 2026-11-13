import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {McpUpstreamManager} from '../dist/lib/mcp-upstream-manager.js';
import {ExtensionStore} from '../dist/lib/extension-store.js';
import {loadProjectSkills,loadProjectSkill} from '../dist/lib/skills-loader.js';
import {loadExtensions} from '../dist/lib/user-extensions.js';
const base=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-content-'));
try{
 const work=path.join(base,'work'),source=path.join(base,'source');await fs.mkdir(work);await fs.mkdir(path.join(source,'skills','demo'),{recursive:true});
 const skill='---\nname: demo\ndescription: Fixture guidance\n---\n# Demo\nDo nothing executable.\n';
 await fs.writeFile(path.join(source,'skills','demo','SKILL.md'),skill);
 await fs.writeFile(path.join(source,'NOTES.md'),'# Fixture imported instructions\n');
 await fs.writeFile(path.join(source,'bridge-dev.json'),JSON.stringify({version:1,pack:{name:'fixture-pack',description:'Generic mixed pack'},skills:['skills/demo'],instructions:['NOTES.md'],servers:[{id:'fixture',name:'Fixture provider',enabled:true,transport:'stdio',command:'never-executed',expose:'all'}]}));
 const store=new ExtensionStore(work);
 const proposal=await store.propose(source,['pack:fixture-pack']);assert.ok(proposal.selection.includes('skill:demo'));assert.ok(proposal.selection.includes('mcp:fixture'));
 const other=path.join(base,"other-workspace");await fs.mkdir(other);await assert.rejects(new ExtensionStore(other).apply(proposal.id),/WORKSPACE_CHANGED/);
 await store.apply(proposal.id);
 assert.equal((await store.list()).length,4);assert.ok((await store.list()).every(entry=>entry.enabled===false));
 assert.equal((await loadProjectSkills(work)).some(s=>s.name==='demo'),false);
 await store.apply((await store.proposeAction('enable','skill:demo')).id);
 assert.match((await loadProjectSkill(work,'demo')).content,/Untrusted skill guidance/);
 assert.equal((await store.validate())[0].valid,true);
 await store.apply((await store.proposeAction('enable','instructions:notes')).id);
 assert.match((await loadExtensions(work)).instructions[0].content,/Untrusted imported Markdown/);
 await assert.rejects(store.apply((await store.proposeAction('enable','mcp:fixture')).id),/PROVIDER_REVIEW/);
 const user=await store.propose(source,['skill:demo'],'user');await store.apply(user.id);
 const resolved=(await store.list()).find(entry=>entry.key==='skill:demo');assert.equal(resolved.scope,'project');assert.equal(resolved.overrides_user,true);
 await fs.writeFile(path.join(source,'skills','demo','SKILL.md'),skill+'Updated fixture.\n');
 const update=await store.proposeAction('update','skill:demo');assert.notEqual(update.discovery.digest,resolved.digest);await store.apply(update.id);
 assert.equal((await store.list()).find(e=>e.key==='skill:demo').enabled,false,'updated content requires fresh enable');
 await store.apply((await store.proposeAction('enable','skill:demo')).id);assert.match((await loadProjectSkill(work,'demo')).content,/Updated fixture/);
 await store.apply((await store.proposeAction('disable','skill:demo')).id);await assert.rejects(loadProjectSkill(work,'demo'),/Unknown/);
 const stale=await store.proposeAction('update','skill:demo');await store.apply((await store.proposeAction('remove','pack:fixture-pack')).id);await assert.rejects(store.apply(stale.id),/STALE/);
 assert.equal((await store.read('project')).entries.length,0);assert.equal((await store.list()).length,1,'user entry remains after project pack removal');
 await store.apply((await store.proposeAction('remove','skill:demo','user')).id);assert.equal((await store.list()).length,0);
 const scopedWork=path.join(base,'scoped-work');await fs.mkdir(scopedWork);const manager=new McpUpstreamManager(path.join(base,'scoped-providers.json'));await manager.init();const scoped=new ExtensionStore(scopedWork,undefined,manager);
 try{
  await scoped.apply((await scoped.propose(source,['mcp:fixture'],'user')).id);await scoped.apply((await scoped.proposeProvider('fixture',{enabled:true,expose:'none'})).id);
  await scoped.apply((await scoped.propose(source,['skill:demo'],'project')).id);assert.equal(manager.listServerConfigs().length,1);assert.equal(manager.getServerConfig('fixture').enabled,true,'Unrelated project content reset the user provider');
  await scoped.apply((await scoped.propose(source,['mcp:fixture'],'project')).id);assert.equal(manager.listServerConfigs().length,1);assert.equal(manager.getServerConfig('fixture').enabled,false,'Project override must start disabled');
  await scoped.apply((await scoped.proposeAction('remove','mcp:fixture','project')).id);assert.equal(manager.getServerConfig('fixture').enabled,true,'Removing project override did not restore reviewed user provider');
  await scoped.apply((await scoped.proposeAction('disable','skill:demo','project')).id);assert.equal(manager.getServerConfig('fixture').enabled,true);await scoped.apply((await scoped.proposeAction('remove','mcp:fixture','user')).id);assert.equal(manager.listServerConfigs().length,0);
 }finally{await manager.shutdown();}
 console.log('Managed content: pack review, user/project precedence, skill loading, Markdown, validation, update, disable, stale proposals and removal PASS');
}finally{await fs.rm(base,{recursive:true,force:true});}
