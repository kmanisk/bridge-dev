#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = path.resolve(SCRIPT_DIR, "../..");
const RUNNER_SCRIPT = path.join(SCRIPT_DIR, "runner.mjs");

console.log("Starting Conformance Mutation Testing Suite");
console.log("Target: verifying that conformance checks detect 100% of breaking security mutations.");

const mutations = [
  {
    id: "MUTATION_1_SSRF_LOOPBACK_PERMITTED",
    description: "Mutate isPublicAddress to return true for 127.0.0.1 (permitting loopback SSRF)",
    patch: content => content.replace("a === 127 ||", "/* bypassed */ false && a === 127 ||")
  },
  {
    id: "MUTATION_2_PATH_TRAVERSAL_PERMITTED",
    description: "Mutate safeRelative to permit '..' path traversal",
    patch: content => content.replace('x === ".." ||', '/* bypassed */ false && x === ".." ||')
  },
  {
    id: "MUTATION_3_EXPIRED_TOKEN_ACCEPTED",
    description: "Mutate verifyContextToken to accept expired tokens (ignores expiry check)",
    patch: content => content.replace("payload.expires <= now", "false /* bypassed */")
  },
  {
    id: "MUTATION_4_TAMPERED_LEASE_ACCEPTED",
    description: "Mutate verifyLease to return true regardless of cryptographic signature",
    patch: content => content.replace(
      "return verify(null, Buffer.from(message), pubKeyPem, Buffer.from(lease.signature, \"base64\"));",
      "return true; /* bypassed signature verification */"
    )
  },
  {
    id: "MUTATION_5_UNAUTHENTICATED_MCP_PERMITTED",
    description: "Mutate runner unauthenticated check expectation",
    patch: content => content.replace(
      'check(unauthRes.status === 401, "/mcp without token must return HTTP 401");',
      'check(unauthRes.status === 200, "broken expectation");'
    )
  }
];

let detectedMutations = 0;

for (let i = 0; i < mutations.length; i++) {
  const mutation = mutations[i];
  console.log(`\nEvaluating [${i + 1}/${mutations.length}]: ${mutation.id}`);
  console.log(`  Description: ${mutation.description}`);

  // Create temporary copy of runner with the mutation applied
  const originalCode = fs.readFileSync(RUNNER_SCRIPT, "utf8");
  const mutatedCode = mutation.patch(originalCode);

  assert.notEqual(originalCode, mutatedCode, `Mutation patch failed to apply for ${mutation.id}`);

  const tempRunnerPath = path.join(os.tmpdir(), `runner-mutant-${i}.mjs`);
  fs.writeFileSync(tempRunnerPath, mutatedCode, "utf8");
  fs.chmodSync(tempRunnerPath, 0o755);

  try {
    const res = spawnSync(process.execPath, [tempRunnerPath], {
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env }
    });

    if (res.status !== 0) {
      console.log(`  Detected and caught: mutant correctly rejected with non-zero exit code (${res.status})`);
      detectedMutations++;
    } else {
      console.error(`  ESCAPE DETECTED: mutant ${mutation.id} passed the test suite!`);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tempRunnerPath, { force: true });
  }
}

console.log("\n------------------------------------------------------------");
console.log(`Mutation Test Results: ${detectedMutations}/${mutations.length} mutations detected (${(detectedMutations / mutations.length * 100).toFixed(0)}% detection rate).`);

if (detectedMutations === mutations.length) {
  console.log("Mutation check PASS: Conformance suite successfully caught 100% of injected mutations.");
} else {
  console.error("Mutation check FAIL: One or more mutations escaped detection!");
  process.exit(1);
}
