// Real, non-privileged Linux namespace and full MCP shadow acceptance.
// CI-only fixture; never touches the installed user gateway, controller, or lease.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createReleaseBundle,stageBundle} from "../dist/lib/service-release.js";
import {runShadowAcceptance} from "../dist/lib/shadow-update.js";

if(process.platform!=="linux")throw Error("SHADOW_LINUX_REQUIRED");
const dir=await fs.mkdtemp(path.join(os.tmpdir(),"bridge-shadow-e2e-"));
try{
 const commit="a".repeat(40);
 const bundle=await createReleaseBundle(process.cwd(),commit);
 const release=await stageBundle(bundle,dir,commit,{
  verified_ci:true,repository:"kmanisk/bridge-dev",workflow_run:1,
  artifact_id:1,artifact_digest:"sha256:"+"a".repeat(64)
 });
 const result=await runShadowAcceptance(release,dir,37619);
 assert.equal(result.ok,true);
 assert.equal(result.production_network_isolated,true);
 assert.equal(result.production_secrets_inaccessible,true);
 for(const key of ["privilege_and_destructive_denied","second_client_no_root",
   "all_read_schemas","admin_authentication_and_isolation"])
  assert.equal(result.checks[key],true,key);
 const leftover=(await fs.readdir(dir)).filter(name=>name.startsWith(".shadow-"));
 assert.deepEqual(leftover,[],"Temporary namespaces and state not cleaned up");
 console.log("Verified real Bubblewrap namespace, authentic MCP shadow, negative security acceptance and cleanup");
}finally{
 await fs.rm(dir,{recursive:true,force:true});
}
