import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";

const base=await fsp.mkdtemp(path.join(os.tmpdir(),"local-coder-policygate-test-"));
const work=path.join(base,"work"), source=path.join(base,"source");
const managedTarget=path.join(work,"managed-target.txt");
const managedSource=path.join(source,"dot_managed-target.txt");
// The policy bypass fixtures must be reproducible on CI machines without
// chezmoi installed. This local mock reports unmanaged paths only; source
// tracking is separately covered by dedicated real-chezmoi regression tests.
const fixtureBin=path.join(base,"bin");
await fsp.mkdir(fixtureBin);
await fsp.writeFile(path.join(fixtureBin,"chezmoi"),
  `#!/bin/sh\nlast=\nfor arg in "$@"; do last="$arg"; done\nif [ "$last" = "${managedTarget}" ]; then printf '%s\\n' "${managedSource}"; exit 0; fi\nprintf 'not managed\\n' >&2\nexit 1\n`, {mode:0o755});
process.env.PATH=fixtureBin+path.delimiter+(process.env.PATH||"");
const protectedFile=path.join(work,"protected","settings.conf");
const hardFile=path.join(work,"hard","gateway.ts");
const secretDir=path.join(work,".ssh");
const secretFile=path.join(secretDir,"id_test");
const contextA=path.join(source,"AGENTS.md"), contextB=path.join(source,"docs/system/SYSTEM_CONTEXT.md");
const auditFile=path.join(base,"policy-audit.jsonl"), cfgFile=path.join(base,"policy.json");
const approvalDir=path.join(base,"approvals"), approvedPath=path.join(work,"approval","approved.txt");
for(const d of [work,source,path.dirname(contextB),path.dirname(protectedFile),path.dirname(hardFile),secretDir,path.dirname(approvedPath),approvalDir])await fsp.mkdir(d,{recursive:true});
await fsp.writeFile(contextA,"# fixture agents\n");
await fsp.writeFile(contextB,"# fixture state\n");
await fsp.writeFile(protectedFile,"do not change\n");
await fsp.writeFile(hardFile,"critical gateway\n");
await fsp.writeFile(secretFile,"secret sentinel never disclose\n");
await fsp.writeFile(path.join(work,".env"),"PRIVATE_SHOULD_NOT_LEAK=1\n");
await fsp.writeFile(path.join(work,"visible.txt"),"safe before\n");
await fsp.writeFile(managedTarget,"managed rendered content\n");
await fsp.writeFile(managedSource,"canonical source is unchanged\n");
await fsp.writeFile(approvedPath,"original\n");
const maliciousDir=path.join(base,"outside");await fsp.mkdir(maliciousDir);
const maliciousFile=path.join(maliciousDir,"outside.txt");await fsp.writeFile(maliciousFile,"original outside\n");
const gitInit=spawnSync("git",["init","-q",work],{encoding:"utf8"});if(gitInit.status!==0)throw Error(gitInit.stderr);
const otherGitInit=spawnSync("git",["init","-q",maliciousDir],{encoding:"utf8"});
if(otherGitInit.status!==0)throw Error(otherGitInit.stderr);
const cfg=JSON.parse(await fsp.readFile(new URL("../profiles/policy.example.json",import.meta.url),"utf8"));
Object.assign(cfg,{
  context_files:[contextA,contextB],
  writable_roots:[work],protected_paths:[path.join(work,"protected")],
  secret_paths:[secretDir],approval_paths:[path.join(work,"approval")],
  hard_paths:[hardFile],audit_log:auditFile,
  limits:{max_payload_bytes:200000,max_mutations_per_minute:200,max_denials:5,approval_timeout_ms:300000},
});
await fsp.writeFile(cfgFile,JSON.stringify(cfg,null,2)+"\n");
const keys=generateKeyPairSync("ed25519",{privateKeyEncoding:{format:"pem",type:"pkcs8"},publicKeyEncoding:{format:"pem",type:"spki"}});
const pubFile=path.join(base,"operator.pub");await fsp.writeFile(pubFile,keys.publicKey);
Object.assign(process.env,{
  POLICYGATE_POLICY_FILE:cfgFile,POLICYGATE_APPROVAL_PUBLIC_KEY:pubFile,POLICYGATE_APPROVAL_DIR:approvalDir,
  LOCAL_CODER_CHEZMOI_SOURCE_DIR:source,LOCAL_CODER_CHEZMOI_DESTINATION_DIR:work,
  CHATGPT_TOOL_PROFILE:"full",WORKSPACE_PATH:work,CHECKPOINT_ENABLED:"false",
  CHECKPOINT_PATH:path.join(base,"checkpoints"),POST_EDIT_HOOKS_CONFIG:path.join(base,"hooks-disabled.json"),
});
await fsp.writeFile(process.env.POST_EDIT_HOOKS_CONFIG,JSON.stringify({enabled:false,hooks:[]}));
const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");
const {InMemoryTransport}=await import("@modelcontextprotocol/sdk/inMemory.js");
const {createMcpServer}=await import("../dist/server-factory.js");
const {newPolicySession,PolicyGate}=await import("../dist/lib/policy-gateway.js");
const {classifyTool,NATIVE_TOOL_CLASSES,EXPECTED_NATIVE_REGISTRATION_COUNT,assertRegistryComplete}=await import("../dist/lib/tool-classification.js");
const {HashAudit,verifyAuditFile}=await import("../dist/lib/hash-audit.js");
const {analyzeCommand}=await import("../dist/lib/policy-commands.js");
const {adminAuth,localhostOnly}=await import("../dist/admin/localhost-guard.js");
const {canonicalPath,checkPath}=await import("../dist/lib/policy-paths.js");
const {approvalPayload,requestFingerprint}=await import("../dist/lib/policy-approvals.js");
let passed=0,failed=0;
async function test(name,fn){
  try{await fn();passed++;console.log("OK  "+name);}
  catch(err){failed++;console.error("FAIL "+name+": "+(err?.stack||String(err)));}
}
async function pair(){
  const server=createMcpServer(work,12,[work],false,undefined,undefined,newPolicySession());
  const client=new Client({name:"policygate-regression",version:"1"}, {capabilities:{}});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  return {
    server,client,
    async call(name,args={}){
      const result=await client.callTool({name,arguments:args});
      if(result.isError || result.structuredContent?.ok===false)
        throw Error((result.content||[]).map(x=>x.text||"").join(" ")||JSON.stringify(result.structuredContent||result));
      return result.structuredContent?.data??result;
    },
    async close(){await client.close();await server.close();}
  };
}
async function expectDenied(run,pattern=/(POLICYGATE_|SECURITY_|CHEZMOI_)/){
  let error;
  try{await run();}catch(e){error=e;}
  assert.ok(error,"Expected an actual denied MCP tool call");
  assert.match(String(error),pattern);
}
async function withContext(p){await p.call("system_context",{docs:["agents","current_state"],max_bytes_each:2000});}
async function approvedRequest(matcher = "python3 -c"){
  const files=(await fsp.readdir(approvalDir)).filter(x=>x.endsWith(".request.json"));
  assert.ok(files.length>0,"approval request record missing");
  const requests=await Promise.all(files.map(async name=>JSON.parse(await fsp.readFile(path.join(approvalDir,name),"utf8"))));
  const req=requests.find(item=>item.summary.includes(matcher));
  assert.ok(req,`expected approval request matching "${matcher}" missing`);
  assert.equal(req.tool,"run_command");
  assert.equal(requestFingerprint(req.session_id,req.tool,req.args),req.fingerprint);
  const signature=sign(null,Buffer.from(approvalPayload(req)),keys.privateKey).toString("base64");
  await fsp.writeFile(path.join(approvalDir,req.id+".approved.json"),JSON.stringify({...req,signature})+"\n");
  return req;
}
try{
  await test("classification exact count and closed-world registry",async()=>{
    assert.equal(Object.keys(NATIVE_TOOL_CLASSES).length,73);
    assert.equal(EXPECTED_NATIVE_REGISTRATION_COUNT,73);
    assertRegistryComplete(Object.keys(NATIVE_TOOL_CLASSES));
    assert.throws(()=>classifyTool("new_unknown_tool",{}),/POLICYGATE_UNCLASSIFIED_TOOL/);
    assert.deepEqual([classifyTool("system_job",{action:"status"}).kind,classifyTool("system_job",{action:"start"}).kind],["R","X"]);
    assert.equal(classifyTool("ponytail_turn",{action:"status"}).kind,"X");
    assert.equal(classifyTool("mcp_servers",{refresh:true}).kind,"X");
    assert.equal(classifyTool("rewind",{action:"list"}).kind,"R");
  });
  await test("unknown config keys fail startup",async()=>{
    const modified={...cfg,bogus:true},f=path.join(base,"bad-policy.json");
    await fsp.writeFile(f,JSON.stringify(modified));
    assert.throws(()=>new PolicyGate(f),/UNKNOWN_KEY/);
  });
  await test("admin authentication fails closed, rejects absent/invalid tokens and unspecified peers",async()=>{
    const saved=process.env.ADMIN_TOKEN;
    const req={headers:{},socket:{remoteAddress:"127.0.0.1"}};
    const result=()=>{
      let code=200,body=null,passed=false;
      const res={status(value){code=value;return this;},json(value){body=value;return this;}};
      return {res,read:()=>({code,body,passed}),next:()=>{passed=true;}};
    };
    try{
      delete process.env.ADMIN_TOKEN;
      let r=result();adminAuth(req,r.res,r.next);
      assert.equal(r.read().code,503);assert.equal(r.read().passed,false);
      process.env.ADMIN_TOKEN="isolated-admin-test-token";
      r=result();adminAuth(req,r.res,r.next);
      assert.equal(r.read().code,401);assert.equal(r.read().passed,false);
      r=result();adminAuth({...req,headers:{authorization:"Bearer wrong"}},r.res,r.next);
      assert.equal(r.read().code,401);
      r=result();adminAuth({...req,headers:{authorization:"Bearer isolated-admin-test-token"}},r.res,r.next);
      assert.equal(r.read().passed,true);
      r=result();localhostOnly({...req,socket:{remoteAddress:"0.0.0.0"}},r.res,r.next);
      assert.equal(r.read().code,403);
      r=result();localhostOnly(req,r.res,r.next);
      assert.equal(r.read().passed,true);
    }finally{
      if(saved===undefined)delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN=saved;
    }
  });
  await test("production preflight refuses non-service UID and missing privileged configuration",async()=>{
    const check=spawnSync(process.execPath,["scripts/production-preflight.mjs"],{cwd:path.resolve(new URL("..",import.meta.url).pathname),encoding:"utf8"});
    assert.equal(check.status,1);
    assert.match(check.stderr,/PRODUCTION_PREFLIGHT_FAILED/);
  });
  await test("production preflight validates token security and rejects predictable credentials",async()=>{
    const { validateSecureToken } = await import("../scripts/production-preflight.mjs");
    assert.throws(()=>validateSecureToken("short"), /at least 32 characters/);
    assert.throws(()=>validateSecureToken("REPLACE_WITH_PRIVATE_RANDOM_SECRET_12345"), /predictable placeholder/);
    assert.throws(()=>validateSecureToken("this_is_a_default_password_that_is_long"), /predictable placeholder/);
    assert.throws(()=>validateSecureToken("example_token_value_of_32_characters_ok"), /predictable placeholder/);
    assert.throws(()=>validateSecureToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), /only repeated identical/);
    assert.throws(()=>validateSecureToken("12345678123456781234567812345678"), /predictable repeating pattern/);
    assert.throws(()=>validateSecureToken("01234567890123456789012345678901"), /predictable sequential/);
    assert.doesNotThrow(()=>validateSecureToken("9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a"));
  });
  await test("admin UI assets exist and are accessible",async()=>{
    const root=path.resolve(new URL("..",import.meta.url).pathname);
    const uiDir=path.join(root,"public/ui");
    assert.ok(fs.existsSync(path.join(uiDir,"index.html")),"index.html must exist");
    assert.ok(fs.existsSync(path.join(uiDir,"app.js")),"app.js must exist");
    assert.ok(fs.existsSync(path.join(uiDir,"styles.css")),"styles.css must exist");
    const html=await fsp.readFile(path.join(uiDir,"index.html"),"utf8");
    assert.ok(html.includes("<!DOCTYPE html>") || html.includes("<html"));
  });
  await test("unclassified native registration rejected immediately",async()=>{
    const p=await pair();
    try {assert.throws(()=>p.server.registerTool("new_unknown_tool",{inputSchema:{}},async()=>({content:[]})),/UNCLASSIFIED_TOOL/);}
    finally{await p.close();}
  });
  await test("W/X refused before context; R permitted",async()=>{
    const p=await pair();
    try {
      const read=await p.call("read_text_file",{path:path.join(work,"visible.txt")});assert.match(read.content,/safe before/);
      await expectDenied(()=>p.call("write_file",{path:path.join(work,"new.txt"),content:"denied"}),/CONTEXT_REQUIRED/);
      await expectDenied(()=>p.call("run_command",{command:"pwd"}),/CONTEXT_REQUIRED/);
      assert.equal(fs.existsSync(path.join(work,"new.txt")),false);
    }finally{await p.close();}
  });
  await test("docs changes invalidate context; reload required",async()=>{
    const p=await pair();
    try{
      await withContext(p);
      await fsp.appendFile(contextA,"refresh needed\n");
      await expectDenied(()=>p.call("write_file",{path:path.join(work,"new.txt"),content:"must fail"}),/CONTEXT_REQUIRED/);
      await withContext(p);
      const result=await p.call("edit_file",{path:path.join(work,"visible.txt"),old_text:"safe before",new_text:"safe after"});
      assert.ok(result.path);
    }finally{await p.close();}
  });
  await test("read-only Git status works after bootstrap",async()=>{
    const p=await pair();try{await withContext(p);const r=await p.call("git_status",{path:work});assert.ok(r.output);}finally{await p.close();}
  });
  await test("Git branch/stash list are read-only outside writable roots",async()=>{
    const p=await pair();try{
      const branches=await p.call("git_branch",{path:maliciousDir,action:"list"});
      const stashes=await p.call("git_stash",{path:maliciousDir,action:"list"});
      assert.equal(branches.action,"list");assert.equal(stashes.action,"list");
      await withContext(p);
      await expectDenied(()=>p.call("git_branch",{path:maliciousDir,action:"create",name:"blocked"}),/OUTSIDE_WRITABLE_ROOTS/);
      await expectDenied(()=>p.call("git_stash",{path:maliciousDir,action:"push"}),/OUTSIDE_WRITABLE_ROOTS/);
    }finally{await p.close();}
  });
  await test("deny outside, protected, symlink, dangling link, traversal",async()=>{
    const symlink=path.join(work,"linked.txt"),dangling=path.join(work,"dangling.txt");
    await fsp.symlink(maliciousFile,symlink);await fsp.symlink(path.join(base,"nonexistent","foo"),dangling);
    const p=await pair();
    try{
      await withContext(p);
      for(const file of [maliciousFile,protectedFile,symlink,dangling,path.join(work,"..","outside","outside.txt")])
        await expectDenied(()=>p.call("write_file",{path:file,content:"evil"}));
      assert.equal(await fsp.readFile(maliciousFile,"utf8"),"original outside\n");
      assert.equal(await fsp.readFile(protectedFile,"utf8"),"do not change\n");
    }finally{await p.close();}
  });
  await test("every filesystem mutation API refuses protected destination",async()=>{
    const attempts=[
      ["edit_file",{path:protectedFile,old_text:"do not change",new_text:"changed"}],
      ["multi_edit",{path:protectedFile,edits:[{old_text:"do not change",new_text:"changed"}]}],
      ["apply_patch",{path:protectedFile,patch:"*** Begin Patch\n*** Update File: "+protectedFile+"\n@@\n-do not change\n+changed\n*** End Patch"}],
      ["replace_regex",{path:protectedFile,pattern:"do not change",replacement:"changed"}],
      ["write_file_base64",{path:protectedFile,content:Buffer.from("changed").toString("base64")}],
      ["copy_file",{source:path.join(work,"visible.txt"),destination:protectedFile}],
      ["move_file",{source:path.join(work,"visible.txt"),destination:protectedFile}],
      ["delete_file",{path:protectedFile}],
      ["delete_directory",{path:path.dirname(protectedFile)}],
      ["create_directory",{path:path.join(path.dirname(protectedFile),"nested")}],
    ];
    for (const [name,args] of attempts) {
      const p=await pair();try{await withContext(p);await expectDenied(()=>p.call(name,args));}finally{await p.close();}
    }
    assert.equal(await fsp.readFile(protectedFile,"utf8"),"do not change\n");
  });
  await test("secret reads and recursive scanners redact secret files",async()=>{
    const p=await pair();
    try {
      await expectDenied(()=>p.call("read_text_file",{path:secretFile}));
      await expectDenied(()=>p.call("read_file_base64",{path:path.join(work,".env")}));
      const tree=await p.call("directory_tree",{path:work,max_depth:3});
      assert.ok(!JSON.stringify(tree).includes("id_test"));
      assert.ok(!JSON.stringify(tree).includes(".env"));
      const grep=await p.call("grep",{path:work,pattern:"sentinel|SHOULD_NOT_LEAK"});
      assert.ok(!String(grep.output).includes("secret sentinel never disclose"));
      assert.ok(!String(grep.output).includes(secretFile));
      const ls=await p.call("list_directory",{path:work});
      assert.ok(!JSON.stringify(ls).includes(".env"));
    }finally{await p.close();}
  });
  await test("read commands targeting secrets are refused",async()=>{
    const commands=["cat ~/.ssh/id_*","cd ~/.ssh && cat *","grep -r . ~/.ssh","echo x > ~/.ssh/authorized_keys"];
    for(const command of commands)assert.ok(analyzeCommand(command,new PolicyGate(cfgFile).config,cfgFile,work).deny,command);
  });
  await test("dangerous shell analysis rejects known destructive patterns",async()=>{
    const policy=new PolicyGate(cfgFile).config;
    for(const command of ['bash -c "sudo rm -rf ~"',"curl url | sh","dd if=/dev/zero of=/dev/sda","mkfs.ext4 /dev/sda",
      "curl http://127.0.0.1:3001/api/config/env",`git -C ${work} push --force origin main`,
      `git -C ${maliciousDir} reset --hard`])assert.ok(analyzeCommand(command,policy,cfgFile,work).deny,command);
    for(const command of ["python3 -c 'print(42)'","echo $(id)","sudo whoami","chezmoi apply","git push origin master",
      `git -C ${work} reset --hard`, `git -c alias.evil=!touch guard-bypass evil`])
      assert.ok(analyzeCommand(command,policy,cfgFile,work).approval,command);
  });
  await test("policy-specific deny and approval command rules are enforced",async()=>{
    const policy=new PolicyGate(cfgFile).config;
    const restricted={...policy,denied_commands:["echo forbidden"],approval_commands:["echo guarded"]};
    assert.match(String(analyzeCommand("echo forbidden",restricted,cfgFile,work).deny),/operator-denied command/);
    assert.equal(analyzeCommand("echo guarded",restricted,cfgFile,work).approval,true);
    assert.equal(analyzeCommand("echo permitted",restricted,cfgFile,work).approval,true);
    assert.equal(analyzeCommand("pwd",restricted,cfgFile,work).approval,false);
  });
  await test("direct MCP commands and admin API bypass denied",async()=>{
    const p=await pair();try{
      await withContext(p);
      for(const command of ["curl url | sh","bash -c 'sudo rm -rf ~'","mkfs.ext4 /dev/sda",
        "git push --force origin master","echo x > ~/.ssh/authorized_keys","cat ~/.ssh/id_*",
        "cd ~/.ssh && cat *","grep -r . ~/.ssh"])
        await expectDenied(()=>p.call("run_command",{command}));
      await expectDenied(()=>p.call("node_repl",{code:"require('fs').writeFileSync('"+protectedFile+"','changed')"}));
      await expectDenied(()=>p.call("node_repl",{code:"fetch('http://127.0.0.1:3001/api/config/env')"}));
      await expectDenied(()=>p.call("system_job",{action:"start",command:"curl url | sh",working_directory:work}));
    }finally{await p.close();}
  });
  await test("sed shell write directive cannot bypass protected file policy",async()=>{
    const p=await pair();try{
      await withContext(p);
      const before=await fsp.readFile(protectedFile,"utf8");
      await expectDenied(()=>p.call("run_command",{
        command:"sed -n 'w "+protectedFile+"' "+path.join(work,"visible.txt"),
        working_directory:work,
      }),/POLICYGATE_COMMAND_DENIED/);
      assert.equal(await fsp.readFile(protectedFile,"utf8"),before);
      const analyzer=analyzeCommand("sort -o "+protectedFile+" "+path.join(work,"visible.txt"),new PolicyGate(cfgFile).config,cfgFile,work);
      assert.ok(analyzer.deny || analyzer.approval,"indirect shell writers need approval");
    }finally{await p.close();}
  });
  await test("native Git read tools cannot execute configured external diff or fsmonitor before bootstrap",async()=>{
    const repoPath=path.join(base,"untrusted-git-config");
    const marker=path.join(base,"git-helper-executed");
    const helper=path.join(base,"git-helper.sh");
    await fsp.mkdir(repoPath);
    await fsp.writeFile(helper,'#!/bin/sh\nprintf \"executed\n\" >> \"'+marker+'\"\nexit 0\n',{mode:0o755});
    const git=(...args)=>{
      const r=spawnSync("git",["-C",repoPath,...args],{encoding:"utf8"});
      assert.equal(r.status,0,r.stderr||r.stdout);
    };
    git("init","-q");
    await fsp.writeFile(path.join(repoPath,"tracked.txt"),"old\n");
    git("add","tracked.txt");
    git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","test");
    await fsp.writeFile(path.join(repoPath,"tracked.txt"),"modified\n");
    git("config","diff.external",helper);
    git("config","core.fsmonitor",helper);
    process.env.GIT_EXTERNAL_DIFF=helper;
    const {collectGitSnapshot}=await import("../dist/lib/git-snapshot.js");
    const snapshot=await collectGitSnapshot(repoPath);assert.equal(snapshot.is_repo,true);
    assert.equal(fs.existsSync(marker),false,"startup Git context executed an untrusted fsmonitor helper");
    const p=await pair();
    try {
      const d=await p.call("git_diff",{path:repoPath});
      assert.match(d.output,/modified/);
      const s=await p.call("git_status",{path:repoPath});
      assert.match(s.output,/tracked.txt/);
      const l=await p.call("git_log",{path:repoPath});
      assert.ok(l.commits.length>0);
      assert.equal(fs.existsSync(marker),false,"untrusted Git helper executed before context");
      await withContext(p);
      await expectDenied(()=>p.call("run_command",{command:"git -C "+repoPath+" diff --ext-diff",working_directory:work}),/POLICYGATE_APPROVAL_REQUIRED/);
      assert.equal(fs.existsSync(marker),false,"untrusted Git helper executed through command without approval");
    }finally {
      delete process.env.GIT_EXTERNAL_DIFF;
      await p.close();
    }
  });
  await test("git commit default stage-all and hooks require approval",async()=>{
    const p=await pair();try{await withContext(p);
      await expectDenied(()=>p.call("git_commit",{path:work,message:"must-not-run"}),/APPROVAL_REQUIRED/);
    }finally{await p.close();}
  });
  await test("ponytail hook cannot run without approval",async()=>{
    const p=await pair();try{await withContext(p);
      await expectDenied(()=>p.call("ponytail_turn",{action:"turn",prompt:"hello"}),/APPROVAL_REQUIRED/);
    }finally{await p.close();}
  });
  await test("dynamic proxy is registered but requires approval",async()=>{
    const p=await pair();try{
      await withContext(p);
      p.server.registerTool("untrusted__remote",{inputSchema:{}},async()=>({content:[{type:"text",text:"should not execute"}]}));
      await expectDenied(()=>p.call("untrusted__remote",{}),/APPROVAL_REQUIRED/);
    }finally{await p.close();}
  });
  await test("signed approval is single-use",async()=>{
    const p=await pair();try{
      await withContext(p);
      const args={command:"python3 -c 'print(42)'",working_directory:work};
      await expectDenied(()=>p.call("run_command",args),/APPROVAL_REQUIRED/);
      const req=await approvedRequest();
      assert.ok(req.summary.includes("python3"));
      const result=await p.call("run_command",args);
      assert.match(result.stdout,/42/);
      await expectDenied(()=>p.call("run_command",args),/APPROVAL_REQUIRED/);
    }finally{await p.close();}
  });
  await test("edited approval request summary and args cannot be reused",async()=>{
    const p=await pair();try{
      await withContext(p);
      const args={command:"python3 -c 'print(13)'",working_directory:work};
      await expectDenied(()=>p.call("run_command",args),/APPROVAL_REQUIRED/);
      const requests=(await fsp.readdir(approvalDir)).filter(x=>x.endsWith(".request.json"));
      const fn=path.join(approvalDir,requests.find(x=>
        JSON.parse(fs.readFileSync(path.join(approvalDir,x),"utf8")).summary.includes("print(13)")));
      const req=JSON.parse(await fsp.readFile(fn,"utf8"));
      await fsp.writeFile(fn,JSON.stringify({...req,summary:"run_command: ls",args:{command:"ls"}}));
      await expectDenied(()=>p.call("run_command",args),/APPROVAL_REQUEST_TAMPERED/);
    }finally{await p.close();}
  });
  await test("approved privileged command does not fail with SECURITY_PRIVILEGED_COMMAND_REQUIRED",async()=>{
    const p=await pair();try{
      await withContext(p);
      const args={command:"id -u",working_directory:work};
      await expectDenied(()=>p.call("run_command",args),/APPROVAL_REQUIRED/);
      await approvedRequest("id -u");
      const result=await p.call("run_command",args);
      assert.ok(!result.stderr?.includes("SECURITY_PRIVILEGED_COMMAND_REQUIRED"));
      assert.equal(result.exit_code,0);
    }finally{await p.close();}
  });
  await test("tampered, truncated and reordered ledgers fail verification/startup",async()=>{
    const f=path.join(base,"verify-audit.jsonl");
    const a=new HashAudit(f);await a.append({tool:"one"});await a.append({tool:"two"});
    const original=await fsp.readFile(f,"utf8"),lines=original.trimEnd().split("\n");
    assert.equal(verifyAuditFile(f).entries,2);
    await fsp.writeFile(f,lines[1]+"\n"+lines[0]+"\n");
    assert.throws(()=>verifyAuditFile(f),/CHAIN_BROKEN/);
    assert.throws(()=>new HashAudit(f),/CHAIN_BROKEN/);
    await fsp.writeFile(f,original.slice(0,-2));
    assert.throws(()=>verifyAuditFile(f),/TRUNCATED|MALFORMED/);
    await fsp.writeFile(f,original.replace('"tool":"one"','"tool":"tamper"'));
    assert.throws(()=>verifyAuditFile(f),/HASH_MISMATCH/);
  });
  await test("unmodifiable policy/audit/hard paths across strict, standard, dangerous",async()=>{
    for(const profile of ["strict","standard","dangerous"]){
      const variant={...cfg,profile,dangerous_enabled:profile==="dangerous"};
      const configFile=path.join(base,"config-"+profile+".json");
      await fsp.writeFile(configFile,JSON.stringify(variant));
      if(profile==="dangerous")process.env.POLICYGATE_DANGEROUS="yes";
      const gate=new PolicyGate(configFile);
      const session=newPolicySession();session.contextHash=await gate.contextHash();
      for(const filename of [configFile,auditFile,hardFile]){
        await expectDenied(()=>gate.authorize(session,"write_file",{path:filename,content:"evil"}),/POLICYGATE_/);
      }
      delete process.env.POLICYGATE_DANGEROUS;
    }
  });
  await test("generated files reject editing without touching the target",async()=>{
    const generated=path.join(work,"rendered-generated.conf");
    await fsp.writeFile(generated,"# generated by fixture do not edit\nvalue=original\n");
    const p=await pair();
    try{
      await withContext(p);
      await expectDenied(()=>p.call("edit_file",{path:generated,old_text:"original",new_text:"modified"}),/CHEZMOI_/);
      assert.match(await fsp.readFile(generated,"utf8"),/original/);
    }finally{await p.close();}
  });
  await test("redirected chezmoi sources outside writable roots are not mutated",async()=>{
    const p=await pair();try{
      await withContext(p);
      for(const [name,args] of [
        ["edit_file",{path:managedTarget,old_text:"managed rendered",new_text:"altered"}],
        ["multi_edit",{path:managedTarget,edits:[{old_text:"managed rendered",new_text:"altered"}]}],
        ["write_file",{path:managedTarget,content:"altered"}],
        ["apply_patch",{path:managedTarget,patch:"@@\n-managed rendered content\n+altered\n"}],
      ]) await expectDenied(()=>p.call(name,args),/OUTSIDE_WRITABLE_ROOTS/);
      assert.equal(await fsp.readFile(managedSource,"utf8"),"canonical source is unchanged\n");
      assert.equal(await fsp.readFile(managedTarget,"utf8"),"managed rendered content\n");
    }finally{await p.close();}
  });
  await test("rewind restore checks protected checkpoint targets",async()=>{
    process.env.CHECKPOINT_ENABLED="true";
    const {checkpointBefore}=await import("../dist/lib/checkpoint.js");
    const id=await checkpointBefore("test",[protectedFile]);
    process.env.CHECKPOINT_ENABLED="false";
    assert.ok(id);
    const p=await pair();
    try{
      await withContext(p);
      await expectDenied(()=>p.call("rewind",{action:"restore",checkpoint_id:id}),/POLICYGATE_/);
      assert.equal(await fsp.readFile(protectedFile,"utf8"),"do not change\n");
    }finally{await p.close();}
  });
  await test("Git reset and remote push require out-of-band approval",async()=>{
    const p=await pair();
    try{
      await withContext(p);
      await expectDenied(()=>p.call("git_reset",{path:work,mode:"hard",ref:"HEAD"}),/APPROVAL_REQUIRED/);
      await expectDenied(()=>p.call("git_push",{path:work,remote:"origin",branch:"main"}),/APPROVAL_REQUIRED/);
    }finally{await p.close();}
  });
  await test("denial lockout is session-scoped and operator-only",async()=>{
    const p=await pair();
    try{
      await withContext(p);
      for(let i=0;i<cfg.limits.max_denials;i++)
        await expectDenied(()=>p.call("write_file",{path:maliciousFile,content:"denied"}));
      await expectDenied(()=>p.call("read_text_file",{path:path.join(work,"visible.txt")}),/SESSION_LOCKED/);
    }finally{await p.close();}
  });
  await test("per-session mutation rate limit",async()=>{
    const policy={...cfg,limits:{...cfg.limits,max_mutations_per_minute:1}};
    const file=path.join(base,"rate-policy.json");await fsp.writeFile(file,JSON.stringify(policy));
    const gate=new PolicyGate(file), session=newPolicySession();session.contextHash=await gate.contextHash();
    await gate.authorize(session,"write_file",{path:path.join(work,"rate-one.txt"),content:"first"});
    await expectDenied(()=>gate.authorize(session,"write_file",{path:path.join(work,"rate-two.txt"),content:"second"}),/RATE_LIMIT/);
  });
  await test("single-file and multi-file move patches cannot alter protected targets",async()=>{
    const p=await pair();
    try {
      await withContext(p);
      await expectDenied(()=>p.call("apply_patch",{
        path: protectedFile,
        patch:"@@\n-do not change\n+changed\n",
      }),/POLICYGATE_/);
      await expectDenied(()=>p.call("apply_patch",{
        path: work,
        patch:"*** Begin Patch\n*** Update File: visible.txt\n*** Move to: protected/settings.conf\n@@\n-safe before\n+changed\n*** End Patch",
      }),/POLICYGATE_/);
      assert.equal(await fsp.readFile(protectedFile,"utf8"),"do not change\n");
    } finally { await p.close(); }
  });
  await test("shell scanners and bare secret filenames cannot bypass path rules",async()=>{
    const passwordFile=path.join(work,"local-credential.pem");
    await fsp.writeFile(passwordFile,"do not disclose\n");
    const p=await pair();
    try {
      await withContext(p);
      for(const command of [
        "cat local-credential.pem", "cat *", "ls *.pem",
        "grep -r . .", "rg -uuu sentinel .", "rg PRIVATE_SHOULD_NOT_LEAK .", "find .", "find . -exec sh -c 'echo leaked' \;",
        "sed -i 's/do not change/changed/' protected/settings.conf",
        "cp visible.txt protected/settings.conf",
        "mv visible.txt protected/settings.conf",
      ]) await expectDenied(()=>p.call("run_command",{command,working_directory:work}),/POLICYGATE_/);
      assert.equal(await fsp.readFile(protectedFile,"utf8"),"do not change\n");
      assert.equal(await fsp.readFile(passwordFile,"utf8"),"do not disclose\n");
    } finally { await p.close(); }
  });
  await test("system_context detailed paths cannot read secret documentation",async()=>{
    const restricted=path.join(source,"docs/private/notes.md");
    await fsp.mkdir(path.dirname(restricted),{recursive:true});
    await fsp.writeFile(restricted,"classified details\n");
    const p=await pair();
    try {
      await expectDenied(()=>p.call("system_context",{
        docs:["agents","current_state"],detailed_paths:["docs/private/notes.md"],
      }),/POLICYGATE_/);
    } finally { await p.close(); }
  });
  await test("implicit memory writes obey writable_roots",async()=>{
    const p=await pair();
    try {
      await withContext(p);
      await expectDenied(()=>p.call("remember",{note:"must not create external memory file"}),/POLICYGATE_/);
    } finally { await p.close(); }
  });
  await test("the executing package source is immutable even when allowlisted writable",async()=>{
    const {checkPath}=await import("../dist/lib/policy-paths.js");
    const ownRoot=path.resolve(new URL("..",import.meta.url).pathname);
    const broadened={...cfg,writable_roots:[...cfg.writable_roots,ownRoot]};
    assert.throws(()=>checkPath(path.join(ownRoot,"src/server-factory.ts"),"W",broadened,cfgFile),/HARD_PATH_DENIED/);
    assert.throws(()=>checkPath(path.join(ownRoot,"dist/server-factory.js"),"W",broadened,cfgFile),/HARD_PATH_DENIED/);
  });
  await test("audit rejects changed inode, symlinks and redacts sensitive payloads",async()=>{
    const {redactAudit}=await import("../dist/lib/hash-audit.js");
    const fn=path.join(base,"audit-identity-check.jsonl");
    const audit=new HashAudit(fn);
    await audit.append({tool:"capture",args:{command:"curl --password secret-value --token other-secret",content:"binary-payload-secret",code:"process.env.PASSWORD",note:"secret-note"}});
    let content=await fsp.readFile(fn,"utf8");
    assert.ok(!content.includes("secret-value") && !content.includes("other-secret"));
    assert.ok(!content.includes("binary-payload-secret") && !content.includes("process.env.PASSWORD"));
    assert.match(content,/\[REDACTED\]/);
    const other=fn+".moved";
    await fsp.rename(fn,other);
    await fsp.writeFile(fn,content);
    await assert.rejects(audit.append({phase:"attempt"}),/AUDIT_WRITE_FAILED/);
    const link=path.join(base,"audit-link");
    await fsp.symlink(other,link);
    assert.throws(()=>new HashAudit(link),/AUDIT_UNSAFE_PATH/);
    assert.ok(redactAudit({password:"plaintext"}).password==="[REDACTED]");
  });
  await test("write failure blocks action before filesystem mutation",async()=>{
    const p=await pair();try{
      await withContext(p);
      const victim=path.join(work,"audit-failure-target.txt");
      await fsp.writeFile(victim,"before");
      await fsp.rename(auditFile,auditFile+".saved");
      await fsp.mkdir(auditFile);
      await expectDenied(()=>p.call("write_file",{path:victim,content:"after"}),/AUDIT_WRITE_FAILED/);
      assert.equal(await fsp.readFile(victim,"utf8"),"before");
    }finally{await p.close();}
  });
}finally{
  await fsp.rm(base,{recursive:true,force:true});
}
console.log("Policy gateway checks: "+passed+" passed, "+failed+" failed");
if(failed)process.exitCode=1;
