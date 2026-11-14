import {spawnSync} from "node:child_process";
const build=spawnSync(process.execPath,["node_modules/typescript/bin/tsc"],{stdio:"inherit"});
if(build.status!==0)process.exit(build.status||1);
const tests=["patch","tools","checkpoints","mcp-upstream","mcp-oauth","activity-log","project-memory","tool-profile","shell-persist","phase1-safe-edit","phase2-chezmoi","system-enhancements","policy-gateway","policy-upstream-readonly","bridge-dev-cli","portable-runtime","portable-server","provider-router","source-fixtures","managed-content","extension-interfaces","mcp-bridge-integration","extension-security","network-fixtures","managed-session-http","upstream-migration"].map(name=>"scripts/test-"+name+".mjs");
const result=spawnSync(process.execPath,["scripts/isolated-tests.mjs",...tests,"scripts/test-context-capability.mjs","scripts/test-host-controller.mjs","scripts/test-output-schemas.mjs","scripts/sync-tool-counts.mjs"],{stdio:"inherit"});
process.exitCode=result.status||0;
