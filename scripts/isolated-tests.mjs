import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const repo=process.cwd(), base=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-baseline-'));
const work=path.join(base,'work'), source=path.join(base,'source'), bin=path.join(base,'bin');
for(const p of [work,bin,path.join(source,'docs/system')])fs.mkdirSync(p,{recursive:true});
for(const name of ['sudo','tailscale','systemctl'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o700});
for(const [name,text] of Object.entries({'AGENTS.md':'# Mandatory bootstrap\nDaemonless fixture.','docs/system/SYSTEM_CONTEXT.md':'# Fixture state','docs/system/system-philosophy.md':'# Daemonless fixture','docs/system/SUBSYSTEM_MAP.md':'# Fixture map','docs/system/chatgpt-local-coder.md':'# Fixture detail'}))fs.writeFileSync(path.join(source,name),text);
fs.writeFileSync(path.join(work,'AGENTS.md'),'# Fixture\n');
spawnSync('git',['init','-q',work]);
const cfg=JSON.parse(fs.readFileSync('profiles/policy.example.json','utf8'));
Object.assign(cfg,{context_files:[path.join(source,'AGENTS.md'),path.join(source,'docs/system/SYSTEM_CONTEXT.md')],writable_roots:[work],protected_paths:[],secret_paths:[],hard_paths:[],approval_paths:[],audit_log:path.join(base,'policy-audit.jsonl')});
fs.writeFileSync(path.join(base,'policy.json'),JSON.stringify(cfg));
fs.writeFileSync(path.join(base,'hooks.json'),JSON.stringify({enabled:false,hooks:[]}));
const env={PATH:bin+path.delimiter+process.env.PATH,HOME:base,USERPROFILE:base,APPDATA:path.join(base,'appdata'),LOCALAPPDATA:path.join(base,'localappdata'),XDG_CONFIG_HOME:path.join(base,'config'),XDG_DATA_HOME:path.join(base,'data'),XDG_STATE_HOME:path.join(base,'state'),XDG_CACHE_HOME:path.join(base,'cache'),TMPDIR:os.tmpdir(),SystemRoot:process.env.SystemRoot,BRIDGEDEV_RUNTIME_MODE:'portable',BRIDGEDEV_STATE_DIR:path.join(base,'state'),WORKSPACE_PATH:work,MCP_UPSTREAM_CONFIG:path.join(base,'upstream.json'),MCP_OAUTH_STORE:path.join(base,'oauth'),MCP_SHELL_STATE_DIR:path.join(base,'shell'),AUDIT_LOG_PATH:path.join(base,'audit.jsonl'),POST_EDIT_HOOKS_CONFIG:path.join(base,'hooks.json'),POLICYGATE_POLICY_FILE:path.join(base,'policy.json'),POLICYGATE_MODE_FILE:path.join(base,'mode.json'),POLICYGATE_YOLO_LEASE:path.join(base,'lease.json'),POLICYGATE_APPROVAL_DIR:path.join(base,'approvals'),POLICYGATE_APPROVAL_PUBLIC_KEY:'',LOCAL_CODER_CHEZMOI_SOURCE_DIR:source,LOCAL_CODER_CHEZMOI_DESTINATION_DIR:work,CHECKPOINT_ENABLED:'false',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(base,'gitconfig')};
const scripts=process.argv.slice(2);
if(!scripts.length)throw Error('Supply test scripts');
const results=[];
for(const script of scripts){const r=spawnSync(process.execPath,[...(script.endsWith("test-source-fixtures.mjs")?["--experimental-test-module-mocks"]:[]),script,...(script.endsWith("sync-tool-counts.mjs")?["--check-manifest","profiles/native-tool-counts.json"]:[])],{cwd:repo,env,encoding:'utf8',timeout:120000});results.push({script,status:r.status,error:r.error?.message,output:(r.stdout||'')+(r.stderr||'')});console.log(script+' exit '+r.status);}
fs.writeFileSync(path.join(base,'results.json'),JSON.stringify(results,null,2));
fs.rmSync(base,{recursive:true,force:true});
if(results.some(r=>r.status!==0)){for(const r of results.filter(r=>r.status!==0))console.error(r.output);process.exitCode=1;}
