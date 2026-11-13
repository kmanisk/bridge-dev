#!/usr/bin/env node
import { getPolicyGate } from "../dist/lib/policy-gateway.js";
import { verifyAuditFile } from "../dist/lib/hash-audit.js";
try {
  const filename=process.argv[2] || getPolicyGate().config.audit_log;
  const verified=verifyAuditFile(filename);
  console.log(JSON.stringify({ok:true,file:filename,...verified},null,2));
} catch (error) {
  console.error(String(error));
  process.exitCode=1;
}
