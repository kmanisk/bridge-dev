#!/usr/bin/node
// Root-owned, fixed verb allowlist. NEVER accept a service name, shell, file path,
// argv tail, package name, GPU device, VM identifier or arbitrary command.
import { spawnSync } from "node:child_process";

if(process.getuid?.()!==0)throw Error("Root helper requires root UID");
const verb=process.argv[2];
if(process.argv.length!==3)throw Error("Usage: policygate-root-helper.mjs status|start|stop");
const unit="chatgpt-local-coder-policygate.service";
const commands={
  status:["show",unit,"--property=ActiveState,SubState,MainPID,ExecMainStatus","--no-pager"],
  start:["start",unit],
  stop:["stop",unit],
};
if(!Object.hasOwn(commands,verb))throw Error("Refused: verb is outside fixed allowlist");
const child=spawnSync("/usr/bin/systemctl",commands[verb],{
  shell:false,stdio:"inherit",env:{PATH:"/usr/bin:/bin",LANG:"C"},
  timeout:10000,
});
if(child.error)throw child.error;
process.exit(child.status??1);
