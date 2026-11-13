// Test-process module substitution only; no production flag or alternate helper.
import {mock} from 'node:test';
if(!process.env.BRIDGEDEV_TEST_ROOT)throw Error('Isolated HTTP fixture only');
mock.module('../dist/lib/host-controller.js',{namedExports:{
 hostControllerAvailable:()=>true,
 executeHostCommand:async(command,cwd,timeout,approvalId)=>({exit_code:0,stdout:'UNPRIVILEGED_ROUTING_FIXTURE',stderr:'',cwd,timed_out:false,job_id:'fixture-routing-only',job_status:'SUCCESS',fixture_command:command,fixture_approval:approvalId||null}),
 controllerCall:async()=>{throw Error('Real host controller prohibited in fixture');}
}});
await import('../dist/index.js');
