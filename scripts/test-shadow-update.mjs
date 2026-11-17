import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {generateKeyPairSync,sign} from "node:crypto";
import {spawnSync} from "node:child_process";
import {shadowBubblewrapArgs} from "../dist/lib/shadow-update.js";
import {snapshotUpdateLease,assertSameUpdateLease,assertLocalUpdateCgroup} from "../dist/lib/update-lease.js";
import {githubAccessError} from "../dist/lib/service-release.js";

const base=await fs.mkdtemp(path.join(os.tmpdir(),"bridge-shadow-fixture-"));
try{
  for(const file of ["scripts/shadow-release-acceptance.mjs","scripts/deploy-acceptance/positive-client.mjs"]){
    const checked=spawnSync(process.execPath,["--check",file],{encoding:"utf8",timeout:5000});
    assert.equal(checked.status,0,checked.stderr);
  }
  const args=shadowBubblewrapArgs("/releases/reviewed","/state/isolated","/usr/bin/node",3000);
  for(const origin of [
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/bridge-dev.service",
    "0::/user.slice/user-1000.slice/user@1000.service/app.slice/bridge-dev-update-fixture.service"
  ])assert.throws(()=>assertLocalUpdateCgroup(origin),/UPDATE_MCP_PROCESS_ORIGIN_DENIED/);
  assert.doesNotThrow(()=>assertLocalUpdateCgroup("0::/user.slice/user-1000.slice/session-1.scope"));
  for(const required of ["--unshare-all","--die-with-parent","--new-session",
    "--clearenv","--tmpfs","--ro-bind","--bind","/release","/shadow"])
    assert.ok(args.includes(required),required);
  assert.ok(!args.includes("/home/onyx")&&!args.includes("/var/lib/bridge-dev-operator"));
  assert.deepEqual(args.slice(-3),["--","/opt/shadow-node",
    "/release/scripts/shadow-release-acceptance.mjs"]);
  for(const bad of ["relative","../../etc"]){
    assert.throws(()=>shadowBubblewrapArgs(bad,"/tmp/work","/usr/bin/node",3000),
      /SHADOW_ABSOLUTE_PATH_REQUIRED/);
  }
  assert.throws(()=>shadowBubblewrapArgs("/release","/tmp/work","/usr/bin/node",0),
    /SHADOW_PRODUCTION_PORT_INVALID/);
  for(const [err,reason] of [
    [{code:"ENOENT"},"GH_BINARY_MISSING"],
    [{stderr:"HTTP 401 Bad credentials"},"GITHUB_AUTH_DENIED"],
    [{stderr:"Could not resolve host github.com"},"GITHUB_NETWORK_FAILED"],
    [{stderr:"rate limit exceeded"},"GITHUB_RATE_LIMITED"],
    [{code:1,stderr:"unexpected example TOKEN=hidden"},"GITHUB_QUERY_FAILED"],
  ])assert.match(githubAccessError(err).message,new RegExp(reason));

  if(process.platform==="linux"||process.platform==="darwin"){
  const {publicKey,privateKey}=generateKeyPairSync("ed25519",{
    publicKeyEncoding:{type:"spki",format:"pem"},
    privateKeyEncoding:{type:"pkcs8",format:"pem"}});
  const pub=path.join(base,"public.pem"),leaseFile=path.join(base,"lease.json"),
    activation=path.join(base,"activation.json");
  await fs.writeFile(pub,publicKey,{mode:0o600});
  const payload={mode:"dangerous",expires_at:null,nonce:"fixture-nonce",
    scope:"host-root-v1",lifetime:"until_off"};
  const lease={...payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString("base64")};
  const marker={mode:"standard",nonce:lease.nonce,expires:null,lifetime:"until_off"};
  await fs.writeFile(leaseFile,JSON.stringify(lease),{mode:0o600});
  await fs.writeFile(activation,JSON.stringify(marker),{mode:0o600});
  const files={lease:leaseFile,activation,key:pub,requireController:false};
  const before=snapshotUpdateLease(files);
  assert.equal(before.mode,"YOLO");
  assert.equal(before.scope,"host-root-v1");
  assert.equal(before.expires_at,null);
  assertSameUpdateLease(before,snapshotUpdateLease(files));
  // A gateway restart changes no independently signed bytes. Tampering,
  // expiry, revocation or new leases must fail, never be silently restored.
  await fs.writeFile(activation,JSON.stringify({mode:"standard"}));
  assert.throws(()=>assertSameUpdateLease(before,snapshotUpdateLease(files)),
    /UPDATE_PROTECTED_LEASE_CHANGED/);
  await fs.writeFile(activation,JSON.stringify(marker));
  await fs.writeFile(leaseFile,JSON.stringify({...lease,nonce:"modified"}));
  assert.throws(()=>snapshotUpdateLease(files),/INVALID_OR_EXPIRED/);
  await fs.writeFile(leaseFile,JSON.stringify(lease));
  const timed={...payload,expires_at:Date.now()+60000};
  delete timed.lifetime;
  const signed={...timed,signature:sign(null,Buffer.from(JSON.stringify(timed)),privateKey).toString("base64")};
  await fs.writeFile(leaseFile,JSON.stringify(signed));
  await fs.writeFile(activation,JSON.stringify({mode:"standard",nonce:signed.nonce,expires:signed.expires_at}));
  const expiry=snapshotUpdateLease(files);
  assert.equal(expiry.expires_at,signed.expires_at);
  await fs.writeFile(leaseFile,JSON.stringify(lease));
  await fs.writeFile(activation,JSON.stringify(marker));
  assert.throws(()=>assertSameUpdateLease(expiry,snapshotUpdateLease(files)),
    /UPDATE_PROTECTED_LEASE_CHANGED/);

  }
  const manager=await fs.readFile("src/lib/service-manager.ts","utf8");
  assert.match(manager,/runShadowAcceptance/);
  assert.match(manager,/checkLeasedGateway\(next\)/);
  assert.match(manager,/job\.shadow_lease[\s\S]*?checkGateway\(next\)/);
  assert.match(manager,/await requireStandardServiceMode\(job\.before\)/);
  const cli=await fs.readFile("src/cli.ts","utf8");
  assert.match(cli,/--standard-window/);
  assert.match(cli,/queueServiceOperation\("update",sha,serviceRoot\(\),undefined,\{shadowLease:lease\}\)/);
}finally{await fs.rm(base,{recursive:true,force:true});}
console.log("Shadow isolation args, GitHub error categories, signed-lease invariance and rollback wiring PASS");
