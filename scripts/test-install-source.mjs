#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectInstallSource, updateInstructions } from "../dist/lib/install-source.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dev-install-kind-"));
try {
  const src = path.join(temp, "source");
  const installed = path.join(temp, "node_modules", "bridge-dev");
  const scoped = path.join(temp, "node_modules", "@kmanisk", "bridge-dev");
  const portable = path.join(temp, "portable", "app");
  const release = path.join(temp, "releases", "abc");
  for (const dir of [src, installed, scoped, portable, release]) fs.mkdirSync(dir, {recursive:true});
  fs.mkdirSync(path.join(portable,"scripts"));
  fs.writeFileSync(path.join(portable,"scripts","install-portable.mjs"),"");
  fs.writeFileSync(path.join(release,"DEPLOYED_COMMIT"),"a".repeat(40)+"\n");

  assert.equal(detectInstallSource(src),"source");
  assert.equal(detectInstallSource(installed),"npm");
  assert.equal(detectInstallSource(scoped),"npm");
  assert.equal(detectInstallSource(portable),"portable-installer");
  assert.equal(detectInstallSource(release),"managed");
  assert.match(updateInstructions("npm"),/^npm install -g bridge-dev@latest/);
  assert.match(updateInstructions("managed"),/bridge-dev update/);
  assert.match(updateInstructions("portable-installer"),/install\.sh/);
  if (process.platform === "linux" && !process.env.BRIDGEDEV_TEST_ROOT) {
    // Synthetic active-release identity; never access the real operator or lease.
    const manager = path.join(temp,"managed-service");
    const sha = "b".repeat(40);
    const active = path.join(manager,"releases",sha);
    const lib = path.join(active,"dist","lib");
    fs.mkdirSync(lib,{recursive:true});
    fs.mkdirSync(path.join(manager,"service"));
    fs.copyFileSync(path.join(process.cwd(),"dist","lib","host-controller.js"),
      path.join(lib,"host-controller.js"));
    fs.writeFileSync(path.join(active,"package.json"),'{"type":"module"}');
    fs.writeFileSync(path.join(active,"DEPLOYED_COMMIT"),sha+"\n");
    fs.symlinkSync(path.join("releases",sha),path.join(manager,"current"));
    fs.writeFileSync(path.join(manager,"service","config.json"),
      JSON.stringify({root:manager,current:sha}),{mode:0o600});
    const previous = process.env.BRIDGEDEV_SERVICE_ROOT;
    try {
      process.env.BRIDGEDEV_SERVICE_ROOT=manager;
      const {verifiedManagedGatewayIdentity} = await import(
        new URL("file://"+path.join(lib,"host-controller.js")));
      assert.equal(verifiedManagedGatewayIdentity(),true);
      fs.writeFileSync(path.join(manager,"service","config.json"),
        JSON.stringify({root:manager,current:"c".repeat(40)}),{mode:0o600});
      assert.equal(verifiedManagedGatewayIdentity(),false,
        "Mismatched release must fail closed");
    } finally {
      if (previous === undefined) delete process.env.BRIDGEDEV_SERVICE_ROOT;
      else process.env.BRIDGEDEV_SERVICE_ROOT=previous;
    }
  }
  console.log("Install-source identification and managed release isolation PASS");
} finally {
  fs.rmSync(temp,{recursive:true,force:true});
}
