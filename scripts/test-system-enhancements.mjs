import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateConfigCandidate } from "../dist/lib/config-validator.js";
import { executeSafeEdit } from "../dist/lib/safe-edit.js";
import { systemBootstrapInstructions, getSystemDocuments } from "../dist/lib/system-context.js";
import { inspectSections } from "../dist/lib/system-inspect.js";
import { listJobs, statusJob } from "../dist/lib/system-jobs.js";
import { runPostEditHooks } from "../dist/lib/post-edit-hooks.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-system-checks-"));
let passed = 0;
function check(message) { passed++; console.log("OK  " + message); }
const old = {
  audit: process.env.AUDIT_LOG_PATH,
  job: process.env.LOCAL_CODER_JOB_ROOT,
  hook: process.env.POST_EDIT_HOOKS_CONFIG,
  checkpoints: process.env.CHECKPOINT_ENABLED,
};
try {
  process.env.LOCAL_CODER_JOB_ROOT = path.join(root, "jobs");
  process.env.CHECKPOINT_ENABLED = "false";
  process.env.AUDIT_LOG_PATH = path.join(root, "audit.jsonl");

  assert.equal((await validateConfigCandidate(path.join(root,"valid.json"),'{"hello":true}')).status,"passed");
  assert.equal((await validateConfigCandidate(path.join(root,"invalid.json"),'{oops')).status,"failed");
  check("JSON candidates validated without writing");

  assert.equal((await validateConfigCandidate(path.join(root,"config.fish"),'set -gx HELLO world\n')).status,"passed");
  assert.equal((await validateConfigCandidate(path.join(root,"bad.fish"),'if true\n')).status,"failed");
  check("fish syntax validator rejects invalid candidate");

  assert.equal((await validateConfigCandidate(path.join(root,"valid.sh"),'echo hello\n')).status,"passed");
  assert.equal((await validateConfigCandidate(path.join(root,"invalid.sh"),'if true; then\n')).status,"failed");
  check("bash syntax validator rejects invalid candidate");

  assert.equal((await validateConfigCandidate(path.join(root,"demo.service"),"[Unit]\nDescription=Test unit\n[Service]\nType=oneshot\nExecStart=/usr/bin/true\n")).status,"passed");
  assert.equal((await validateConfigCandidate(path.join(root,"invalid.service"),"[Service]\nType=oneshot\n")).status,"failed");
  check("systemd-analyze verify evaluates isolated unit candidates");

  assert.equal((await validateConfigCandidate(path.join(root,"dot_config/sway/config"),'output * scale 1.3')).status,"pending");
  assert.equal((await validateConfigCandidate(path.join(root,"dot_config/fish/config.fish.tmpl"),'{{ .foo }}')).status,"pending");
  check("Sway and templates require rendered validation, not false passes");

  const liveFile=path.join(root,"valid.json");
  await fs.writeFile(liveFile,'{"original":true}');
  await assert.rejects(executeSafeEdit({path:liveFile,content:'{bad'}),/CONFIG_VALIDATION_FAILED/);
  assert.equal(await fs.readFile(liveFile,"utf8"),'{"original":true}');
  check("invalid edit rejected before altering existing file");

  const accepted=await executeSafeEdit({path:liveFile,content:'{"valid":true}'});
  assert.equal(accepted.validation.status,"passed");
  check("candidate validation included in successful editing result");

  const boot=await systemBootstrapInstructions();
  assert.match(boot,/Mandatory bootstrap/);
  assert.match(boot,/AGENTS\.md/);
  assert.match(boot,/SUBSYSTEM_MAP/);
  assert.match(boot,/Daemonless|daemonless/);
  check("fresh MCP instructions include canonical system rules");

  const context=await getSystemDocuments(["agents","current_state","philosophy","subsystem_map"],2000,["docs/system/chatgpt-local-coder.md"]);
  assert.equal(context.documents.length,5);
  assert.ok(context.documents.every((doc)=>typeof doc.sha256==="string"));
  const refuse=await getSystemDocuments([],1200,["docs/../../etc/shadow.md"]);
  assert.match(refuse.documents[0].error,/Only Markdown paths/);
  check("detailed canonical docs available, traversal refused");

  const structured=await inspectSections(["resources","services","gpu","sway","audio","bluetooth","drift"]);
  assert.ok(structured.sections.resources.memory.total_bytes>0);
  assert.ok(Array.isArray(structured.sections.resources.load_average));
  assert.ok(structured.sections.drift.docs_required_after_user_acceptance);
  assert.ok(structured.read_only);
  check("read-only system inspector sections return typed JSON and docs plan");

  const jobs=await listJobs();
  assert.deepEqual(jobs.jobs,[]);
  await assert.rejects(statusJob("../outside"),/Invalid Local Coder job ID/);
  check("job metadata bound to strict identifier and no persisted test state");

  const malicious=path.join(root,"config;touch SHOULD_NOT_RUN.json");
  const config=path.join(root,"hooks.json");
  await fs.writeFile(config,JSON.stringify({enabled:true,hooks:[{glob:"*.json",executable:"/usr/bin/printf",args:["%s","{path}"],timeout_ms:3000}]}));
  process.env.POST_EDIT_HOOKS_CONFIG=config;
  const hooks=await runPostEditHooks([malicious]);
  assert.equal(hooks.post_edit_hooks.length,1);
  assert.equal(hooks.post_edit_hooks[0].exit_code,0);
  assert.equal(hooks.post_edit_hooks[0].stdout,malicious);
  await assert.rejects(fs.stat(path.join(root,"SHOULD_NOT_RUN.json")),{code:"ENOENT"});
  check("post-edit argv hook handles metacharacter filename without shell injection");
} finally {
  for(const [key,variable] of Object.entries({audit:"AUDIT_LOG_PATH",job:"LOCAL_CODER_JOB_ROOT",hook:"POST_EDIT_HOOKS_CONFIG",checkpoints:"CHECKPOINT_ENABLED"})) {
    if (old[key] === undefined) delete process.env[variable]; else process.env[variable] = old[key];
  }
  await fs.rm(root,{recursive:true,force:true});
}
console.log("System enhancements: "+passed+" checks passed.");
