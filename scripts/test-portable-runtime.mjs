#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { PolicyGate } from "../dist/lib/policy-gateway.js";
import { getRuntimeMode, makePortablePolicy, platformCapabilities } from "../dist/lib/runtime.js";
import { checkPath } from "../dist/lib/policy-paths.js";
import { inspectChezmoiPath } from "../dist/lib/chezmoi-guard.js";
import { validateExtensionManifest, loadExtensions, formatExtensionsForInstructions } from "../dist/lib/user-extensions.js";
import { loadProjectSkills, loadProjectSkill } from "../dist/lib/skills-loader.js";
import { loadUpstreamConfig, resolveUpstreamConfigPath } from "../dist/lib/mcp-upstream-config.js";
import { systemBootstrapInstructions, getSystemDocuments } from "../dist/lib/system-context.js";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-dev-portable-"));
const workspace=path.join(root,"my-project");
fs.mkdirSync(workspace);
const saved=Object.fromEntries(["POLICYGATE_POLICY_FILE","BRIDGEDEV_RUNTIME_MODE","BRIDGEDEV_STATE_DIR","WORKSPACE_PATH","MCP_UPSTREAM_CONFIG","BRIDGEDEV_SERVICE_ROOT","BRIDGEDEV_INSTALL_ROOT","XDG_DATA_HOME","XDG_CONFIG_HOME"].map(key=>[key,process.env[key]]));
try {
  delete process.env.POLICYGATE_POLICY_FILE;
  process.env.BRIDGEDEV_RUNTIME_MODE="portable";
  process.env.BRIDGEDEV_STATE_DIR=path.join(root,"state");
  process.env.WORKSPACE_PATH=workspace;
  process.env.BRIDGEDEV_SERVICE_ROOT=path.join(root,"service");
  process.env.XDG_DATA_HOME=path.join(root,"share");
  process.env.XDG_CONFIG_HOME=path.join(root,"config");
  delete process.env.MCP_UPSTREAM_CONFIG;
  assert.equal(getRuntimeMode(),"portable");
  const gate=new PolicyGate();
  const config=gate.config;
  assert.equal(config.profile,"standard");
  assert.equal(gate.getActiveProfile(),"standard");
  assert.deepEqual(config.context_files,[]);
  assert.deepEqual(config.writable_roots,[fs.realpathSync.native(workspace)]);
  assert.equal(config.dangerous_enabled,false);
  assert.match(config.audit_log,/audit\.jsonl$/);
  assert.equal(checkPath(path.join(workspace,"allowed.txt"),"W",config,gate.configPath).approval,false);
  assert.throws(()=>checkPath(path.join(root,"private.txt"),"W",config,gate.configPath),/OUTSIDE_WRITABLE_ROOTS/);
  assert.throws(()=>checkPath(path.join(workspace,".env"),"R",config,gate.configPath),/SECRET_DENIED/);
  assert.equal((await inspectChezmoiPath(path.join(workspace,"allowed.txt"))).kind,"unmanaged");
  assert.equal(await systemBootstrapInstructions(),"");
  const docs=await getSystemDocuments(["agents"]);
  assert.equal(docs.configured,false);
  const mcpFile=resolveUpstreamConfigPath();
  assert.equal(mcpFile,path.join(workspace,".bridge-dev","mcp.json"));
  assert.deepEqual((await loadUpstreamConfig()).servers,[]);
  assert.equal(fs.existsSync(mcpFile),false);
  const manifestFolder=path.join(workspace,".bridge-dev");
  fs.mkdirSync(path.join(manifestFolder,"skills","formatting"),{recursive:true});
  await fsp.writeFile(path.join(workspace,"NOTES.md"),"Use the project's formatter.\n");
  await fsp.writeFile(path.join(manifestFolder,"skills","formatting","SKILL.md"),
    "---\nname: formatting\ndescription: Local formatting workflow\n---\n# Formatting\nRun tests before committing.");
  const manifest={version:1,instructions:["NOTES.md"],skill_directories:[".bridge-dev/skills"],links:[
    {title:"External Markdown reference",url:"https://example.com/guide.md"}
  ]};
  await fsp.writeFile(path.join(manifestFolder,"extensions.json"),JSON.stringify(manifest));
  const ext=await loadExtensions(workspace);
  assert.equal(ext.instructions.length,1);
  assert.equal(ext.links.length,1);
  assert.equal(ext.skillDirectories.length,1);
  assert.match(formatExtensionsForInstructions(ext),/Use the project's formatter/);
  assert.match(formatExtensionsForInstructions(ext),/not fetched or trusted/);
  const skills=await loadProjectSkills(workspace);
  assert.ok(skills.some(x=>x.name==="formatting"));
  assert.match((await loadProjectSkill(workspace,"formatting")).content,/Run tests/);
  assert.throws(()=>validateExtensionManifest({...manifest,instructions:["../secret.md"]}),/Invalid instructions/);
  assert.throws(()=>validateExtensionManifest({...manifest,links:[{title:"bad",url:"http://127.0.0.1/"}]}),/Links must/);
  await fsp.writeFile(path.join(manifestFolder,"extensions.json"),JSON.stringify({...manifest,instructions:["../secret.md"]}));
  assert.ok((await loadExtensions(workspace)).warnings.length>0);
  for(const platform of ["linux","win32","darwin","android"]){
    const caps=platformCapabilities(platform);
    assert.equal(caps.capabilities.workspace,"available");
    assert.equal(caps.capabilities.skills,"available");
    assert.equal(caps.capabilities.systemd,platform==="linux"?"optional":"unsupported");
  }
  const spawned=spawnSync(process.execPath,["dist/cli.js","setup"],{
    cwd:process.cwd(),env:{...process.env},encoding:"utf8",timeout:9000
  });
  assert.equal(spawned.status,0,spawned.stderr);
  assert.match(spawned.stdout,/portable/);
  assert.match(spawned.stdout,/^BridgeDev setup: ready · portable · service not installed\s*$/);

  const jsonSpawned=spawnSync(process.execPath,["dist/cli.js","setup","--json"],{
    cwd:process.cwd(),env:{...process.env},encoding:"utf8",timeout:9000
  });
  assert.equal(jsonSpawned.status,0,jsonSpawned.stderr);
  const outer=JSON.parse(jsonSpawned.stdout);
  assert.equal(outer.ok,true);
  const jsonParsed=Array.isArray(outer.output)&&typeof outer.output[0]==="string"?JSON.parse(outer.output[0]):outer;
  assert.equal(jsonParsed.ok,true);
  assert.equal(jsonParsed.runtime,"portable");
  assert.equal(jsonParsed.mode,"portable");
  assert.equal(jsonParsed.service.installed,false);

  const policyFile = path.join(root, "test-policy.json");
  await fsp.writeFile(policyFile, JSON.stringify({
    profile: "standard", dangerous_enabled: false,
    context_files: [], writable_roots: [workspace],
    protected_paths: [], secret_paths: [], secret_names: [],
    approval_paths: [], sensitive_segments: [], hard_paths: [],
    allowed_commands: [], approval_commands: [], denied_commands: [],
    limits: { max_payload_bytes: 1048576, max_mutations_per_minute: 30, max_denials: 5, approval_timeout_ms: 30000 },
    audit_log: path.join(root, "audit.jsonl")
  }));
  const managedSpawned=spawnSync(process.execPath,["dist/cli.js","setup"],{
    cwd:process.cwd(),env:{...process.env,BRIDGEDEV_RUNTIME_MODE:"managed",POLICYGATE_POLICY_FILE:policyFile},encoding:"utf8",timeout:9000
  });
  assert.equal(managedSpawned.status,0,managedSpawned.stderr);
  assert.match(managedSpawned.stdout,/managed/);

  const expanded=spawnSync(process.execPath,["dist/cli.js","setup","--verbose"],{
    cwd:process.cwd(),env:{...process.env},encoding:"utf8",timeout:9000
  });
  assert.equal(expanded.status,0,expanded.stderr);
  assert.match(expanded.stdout,/portable/);
  assert.match(expanded.stdout,/\.bridge-dev/);
  console.log("BridgeDev portable workspace, cross-platform capabilities, Markdown and skills: PASS");
} finally {
  for(const [key,val] of Object.entries(saved)) if(val===undefined)delete process.env[key]; else process.env[key]=val;
  fs.rmSync(root,{recursive:true,force:true});
}
