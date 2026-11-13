#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sign, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { formatMcpEndpoint, isValidSignedLease, inspectLocalMode,
  validateProjectName, resolveProjectDirectory, verifyAuditProof } from "../dist/lib/cli-security.js";
import { HashAudit } from "../dist/lib/hash-audit.js";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-dev-cli-test-"));
const cli=path.resolve("dist/cli.js");
function run(args,env={}) {
  return spawnSync(process.execPath,[cli,...args],{
    encoding:"utf8",timeout:9000,
    env:{...process.env,POLICYGATE_POLICY_FILE:"",BRIDGEDEV_RUNTIME_MODE:"portable",BRIDGEDEV_STATE_DIR:path.join(tmp,"state"),HOME:tmp,MCP_TOKEN:"cli-regression-private-token",...env}
  });
}
try {
  assert.equal(formatMcpEndpoint("https://test.example/","secret"),"https://test.example/mcp/<MCP_TOKEN>");
  assert.equal(formatMcpEndpoint("https://test.example","abc",true),"https://test.example/mcp/abc");
  const conn=run(["connect"]);
  assert.equal(conn.status,0,conn.stderr);
  assert.match(conn.stdout,/\/mcp\/<MCP_TOKEN>/);
  assert.doesNotMatch(conn.stdout,/cli-regression-private-token|headers.*Authorization/i);
  const visible=run(["connect","--show-token"]);
  assert.equal(visible.status,0,visible.stderr);
  assert.match(visible.stdout,/\/mcp\/cli-regression-private-token/);
  const login=run(["login"]);
  assert.equal(login.status,0,login.stderr);
  assert.doesNotMatch(login.stdout,/cli-regression-private-token/);
  const generated=run(["login","--generate"]);
  assert.equal(generated.status,0,generated.stderr);
  assert.match(generated.stdout,/[a-f0-9]{64}/);

  assert.throws(()=>validateProjectName("../../etc"));
  assert.throws(()=>validateProjectName("bad;name"));
  const validDir=path.join(tmp,"safe-project");
  fs.mkdirSync(validDir);
  assert.equal(resolveProjectDirectory(validDir,tmp),validDir);
  assert.throws(()=>resolveProjectDirectory(path.join(tmp,"missing"),tmp));
  const unsafe=run(["project","unmap","../../etc"]);
  assert.notEqual(unsafe.status,0);
  assert.match(unsafe.stderr,/Invalid project/);
  const src=fs.readFileSync("src/cli.ts","utf8");
  assert.match(src,/policygate-project/);
  assert.doesNotMatch(src,/sudo setfacl|sudo mount --bind|sudo umount/);

  const kp=generateKeyPairSync("ed25519"),now=Date.now();
  const lease={mode:"dangerous",expires_at:now+180000,nonce:"hello"};
  const pem=kp.publicKey.export({type:"spki",format:"pem"});
  const signed={...lease,signature:sign(null,Buffer.from(JSON.stringify(lease)),kp.privateKey).toString("base64")};
  assert.equal(isValidSignedLease(signed,pem,now),true);
  assert.equal(isValidSignedLease({...signed,mode:"standard"},pem,now),false);
  assert.equal(isValidSignedLease({...signed,expires_at:now-1},pem,now),false);
  const state=path.join(tmp,"state");fs.mkdirSync(state);
  const pub=path.join(tmp,"operator-public.pem");fs.writeFileSync(pub,pem);
  fs.writeFileSync(path.join(state,"yolo-lease.json"),JSON.stringify(signed));
  assert.equal(inspectLocalMode({stateDir:state,publicKeyFile:pub,now}).mode,"YOLO");
  fs.writeFileSync(path.join(state,"yolo-lease.json"),JSON.stringify({...signed,signature:"invalid"}));
  assert.equal(inspectLocalMode({stateDir:state,publicKeyFile:pub,now}).mode,"UNKNOWN");
  fs.unlinkSync(path.join(state,"yolo-lease.json"));
  fs.writeFileSync(path.join(state,"mode.json"),JSON.stringify({mode:"strict"}));
  assert.equal(inspectLocalMode({stateDir:state,publicKeyFile:pub,now}).mode,"STRICT");

  const log=path.join(tmp,"audit.jsonl"),audit=new HashAudit(log);
  await audit.append({type:"fixture",path:"safe-project"});
  const entry=JSON.parse(fs.readFileSync(log,"utf8").trim());
  const anchor=path.join(tmp,"anchor.json");
  fs.writeFileSync(anchor,JSON.stringify({entries:1,last_hash:entry.hash}));
  assert.equal(verifyAuditProof(log,anchor).entries,1);
  fs.writeFileSync(anchor,JSON.stringify({entries:1,last_hash:"f".repeat(64)}));
  assert.throws(()=>verifyAuditProof(log,anchor));
  console.log("BridgeDev CLI security regression: PASS");
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
