import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {isValidSignedLease} from "./cli-security.js";
import {hostControllerAvailable} from "./host-controller.js";
import {readLeaseActivation,verifyLeaseActivation} from "../../scripts/lease-activation.mjs";

export interface UpdateLeaseSnapshot {
  mode:"YOLO"|"STANDARD";
  fingerprint:string;
  scope:string|null;
  expires_at:number|null;
}
/** Read-only fingerprint of the independently root-controlled activation and
 * exact signed lease. Never create, modify or renew either protected file. */
export function snapshotUpdateLease(options?:{
  lease:string;activation:string;key:string;requireController?:boolean
}):UpdateLeaseSnapshot{
  if(options?.requireController!==false&&!hostControllerAvailable())
    throw Error("UPDATE_HOST_CONTROLLER_UNAVAILABLE");
  const lib=fs.existsSync("/var/lib/local-coder-policygate")?
    "/var/lib/local-coder-policygate":"/var/lib/bridge-dev";
  const etc=fs.existsSync("/etc/local-coder-policygate")?
    "/etc/local-coder-policygate":"/etc/bridge-dev";
  const p=options||{
    lease:process.env.POLICYGATE_YOLO_LEASE||path.join(lib,"yolo-lease.json"),
    activation:process.env.POLICYGATE_YOLO_ACTIVATION_FILE||"/var/lib/bridge-dev-operator/active-lease.json",
    key:process.env.POLICYGATE_APPROVAL_PUBLIC_KEY||path.join(etc,"operator-public.pem")
  };
  let marker:ReturnType<typeof readLeaseActivation> = null;
  try {
    marker=readLeaseActivation(p.activation,p.key);
    if(!marker)throw Error("UPDATE_OPERATOR_ACTIVATION_UNVERIFIED");
  }catch{throw Error("UPDATE_OPERATOR_ACTIVATION_UNVERIFIED");}
  if(marker.mode==="standard"&&!marker.nonce)
    return {mode:"STANDARD",fingerprint:createHash("sha256").update(JSON.stringify(marker)).digest("hex"),
      scope:null,expires_at:null};
  if(!fs.existsSync(p.lease))throw Error("UPDATE_OPERATOR_LEASE_MISSING");
  let lease:any;
  try{lease=JSON.parse(fs.readFileSync(p.lease,"utf8"));}catch{throw Error("UPDATE_OPERATOR_LEASE_INVALID");}
  const pubKey=fs.readFileSync(p.key);
  if(!isValidSignedLease(lease,pubKey)||!verifyLeaseActivation(p.activation,lease,p.key))
    throw Error("UPDATE_OPERATOR_LEASE_INVALID_OR_EXPIRED");
  if(lease.mode!=="dangerous"||lease.scope!=="host-root-v1"||
     typeof lease.nonce!=="string"||!lease.nonce)
    throw Error("UPDATE_OPERATOR_LEASE_SCOPE_INVALID");
  return {
    mode:"YOLO",scope:lease.scope,expires_at:lease.expires_at,
    fingerprint:createHash("sha256")
      .update(JSON.stringify({mode:lease.mode,scope:lease.scope,expires_at:lease.expires_at,
        lifetime:lease.lifetime||null,nonce:lease.nonce,signature:lease.signature,
        activation:marker})).digest("hex")
  };
}
/** Reject direct invocation from the persistent MCP gateway's own systemd
 * cgroup, even when a remote agent has created a synthetic PTY. This is a
 * defense in depth, not proof against a remote principal with arbitrary root. */
export function assertLocalUpdateCgroup(cgroup:string):void{
  if(!cgroup || /(?:^|\\/)bridge-dev(?:[-_][^\\/]+)?\\.service(?:\\/|$)/m.test(cgroup))
    throw Error("UPDATE_MCP_PROCESS_ORIGIN_DENIED: start from your local terminal");
}
export function assertSameUpdateLease(before:UpdateLeaseSnapshot,after:UpdateLeaseSnapshot):void{
  if(before.mode!==after.mode||before.scope!==after.scope||
     before.expires_at!==after.expires_at||before.fingerprint!==after.fingerprint)
    throw Error("UPDATE_PROTECTED_LEASE_CHANGED: never renew or auto-restore");
}
