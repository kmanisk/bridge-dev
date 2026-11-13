#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash, sign, verify, generateKeyPairSync, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const args = process.argv.slice(2);
const action = args[0];
const id = args[1];

const base = path.resolve(process.env.POLICYGATE_APPROVAL_DIR || "/var/lib/local-coder-policygate/approvals");
const keyFile = path.resolve(process.env.POLICYGATE_OPERATOR_PRIVATE_KEY || "/etc/local-coder-policygate/operator-private.pem");
const pubFile = path.resolve(process.env.POLICYGATE_APPROVAL_PUBLIC_KEY || "/etc/local-coder-policygate/operator-public.pem");
const yoloLeasePath = path.resolve(process.env.POLICYGATE_YOLO_LEASE || "/var/lib/local-coder-policygate/yolo-lease.json");
const modeFilePath = path.resolve(process.env.POLICYGATE_MODE_FILE || "/var/lib/local-coder-policygate/mode.json");

if (action !== "status") {
  if (process.getuid?.() !== 0 && process.env.POLICYGATE_TEST_OPERATOR !== "1") {
    throw new Error("Operator action requires actual root UID; never run through the MCP tool connection.");
  }
  if ((!stdin.isTTY || !stdout.isTTY) && process.env.POLICYGATE_TEST_OPERATOR !== "1") {
    throw new Error("Operator action requires an independently opened interactive terminal.");
  }
}

const VALID_ACTIONS = ["approve", "unlock", "keygen", "yolo", "mode", "status"];
if (!VALID_ACTIONS.includes(action)) {
  throw new Error("Usage: policygate-operator.mjs approve <request-id> | unlock <session-id> | keygen | yolo [--duration <min> | --off] | mode <strict|standard|yolo> | status");
}

if (action === "keygen") {
  if (fs.existsSync(keyFile) || fs.existsSync(pubFile)) throw new Error("Signing keys already exist, refusing overwrite");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  fs.writeFileSync(keyFile, pair.privateKey, { mode: 0o400, flag: "wx" });
  fs.writeFileSync(pubFile, pair.publicKey, { mode: 0o444, flag: "wx" });
  console.log("Created root-owned operator key pair; configure the MCP server with public key path only.");
  process.exit(0);
}

if (action === "status") {
  console.log("=== Local Coder Policy Gate Operator Status ===");
  if (fs.existsSync(yoloLeasePath)) {
    try {
      const lease = JSON.parse(fs.readFileSync(yoloLeasePath, "utf8"));
      const pubKey = fs.readFileSync(pubFile, "utf8");
      const msg = JSON.stringify({ mode: lease.mode, expires_at: lease.expires_at, ...(lease.nonce ? { nonce: lease.nonce } : {}) });
      const ok = verify(null, Buffer.from(msg), pubKey, Buffer.from(lease.signature, "base64"));
      if (ok && Date.now() < lease.expires_at) {
        const remainingMin = Math.round((lease.expires_at - Date.now()) / 60000);
        console.log(`Current Mode : YOLO / FULL ACCESS (ACTIVE, ${remainingMin}m remaining, expires: ${new Date(lease.expires_at).toISOString()})`);
        process.exit(0);
      } else {
        console.log("Current Mode : YOLO (EXPIRED / INVALID LEASE - falling back to STANDARD)");
      }
    } catch {
      console.log("Current Mode : STANDARD (lease read error)");
    }
  }
  if (fs.existsSync(modeFilePath)) {
    try {
      const m = JSON.parse(fs.readFileSync(modeFilePath, "utf8"));
      if (m.mode === "strict") {
        console.log("Current Mode : STRICT (Read-only default; operator approval required for mutations)");
        process.exit(0);
      }
    } catch {}
  }
  console.log("Current Mode : STANDARD (Default: safe project dev; signed approval for sudo)");
  process.exit(0);
}

if (action === "yolo") {
  const isOff = args.includes("--off") || id === "--off" || id === "off";
  if (isOff) {
    if (fs.existsSync(yoloLeasePath)) {
      fs.unlinkSync(yoloLeasePath);
    }
    console.log("YOLO mode DEACTIVATED. System immediately returned to STANDARD mode.");
    process.exit(0);
  }

  // Parse duration
  let durationMin = 30;
  const durIdx = args.indexOf("--duration");
  if (durIdx !== -1 && args[durIdx + 1]) {
    const parsed = parseInt(args[durIdx + 1], 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 120) {
      durationMin = parsed;
    }
  }

  const keyStat = fs.statSync(keyFile);
  if (keyStat.uid !== 0 && process.env.POLICYGATE_TEST_OPERATOR !== "1") {
    throw new Error("Signing private key must be root-owned");
  }
  const privateKey = fs.readFileSync(keyFile);

  console.log("\n=======================================================");
  console.log("WARNING: YOLO / FULL ACCESS MODE");
  console.log("This grants unrestricted system-wide administration capabilities.");
  console.log(`Duration: ${durationMin} minutes. Reverts automatically to STANDARD.`);
  console.log("=======================================================\n");

  if (process.env.POLICYGATE_TEST_OPERATOR !== "1") {
    const rl = createInterface({ input: stdin, output: stdout });
    let answer = "", timer;
    try {
      answer = await Promise.race([
        rl.question("Type ENABLE YOLO to confirm activation: "),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Confirmation timeout")), 30000); }),
      ]);
    } finally {
      clearTimeout(timer);
      rl.close();
    }
    if (answer.trim() !== "ENABLE YOLO") throw new Error("Operator cancelled YOLO activation");
  }

  const expires_at = Date.now() + durationMin * 60 * 1000;
  const nonce = randomUUID();
  const leaseMsg = JSON.stringify({ mode: "dangerous", expires_at, nonce });
  const signature = sign(null, Buffer.from(leaseMsg), privateKey).toString("base64");
  const leaseData = {
    mode: "dangerous",
    name: "yolo",
    granted_at: Date.now(),
    expires_at,
    nonce,
    signature
  };

  fs.mkdirSync(path.dirname(yoloLeasePath), { recursive: true, mode: 0o755 });
  fs.writeFileSync(yoloLeasePath, JSON.stringify(leaseData, null, 2) + "\n", { mode: 0o644 });

  console.log(`YOLO mode ENABLED for ${durationMin} minutes.`);
  console.log(`Active until: ${new Date(expires_at).toISOString()}`);
  console.log("To deactivate immediately, run: policygate-operator.mjs yolo --off");
  process.exit(0);
}

if (action === "mode") {
  const targetMode = id?.toLowerCase();
  if (!["strict", "standard", "yolo"].includes(targetMode)) {
    throw new Error("Usage: policygate-operator.mjs mode <strict|standard|yolo>");
  }
  if (targetMode === "yolo") {
    // Re-dispatch to yolo activation
    process.argv = [process.argv[0], process.argv[1], "yolo", ...args.slice(2)];
    // Will be handled above
  } else {
    // If YOLO active, deactivate it
    if (fs.existsSync(yoloLeasePath)) {
      fs.unlinkSync(yoloLeasePath);
    }
    fs.mkdirSync(path.dirname(modeFilePath), { recursive: true, mode: 0o755 });
    fs.writeFileSync(modeFilePath, JSON.stringify({ mode: targetMode, updated_at: Date.now() }, null, 2) + "\n", { mode: 0o644 });
    console.log(`Active mode switched to ${targetMode.toUpperCase()}.`);
    process.exit(0);
  }
}

// approve / unlock actions
if (!id || !/^[a-z0-9-]{16,64}$/.test(id)) throw new Error("Invalid approval request/session ID");
const keyStat = fs.statSync(keyFile);
if ((keyStat.uid !== 0 || (keyStat.mode & 0o077) !== 0) && process.env.POLICYGATE_TEST_OPERATOR !== "1") {
  throw new Error("Signing private key must be root-owned and inaccessible to non-root users");
}
const privateKey = fs.readFileSync(keyFile);
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const input = action === "approve" ? path.join(base, id + ".request.json") : null;
let details, message, output;

if (action === "approve") {
  details = JSON.parse(fs.readFileSync(input, "utf8"));
  if (details.id !== id || Date.now() > details.expires_at || !details.tool ||
    !details.args || typeof details.args !== "object" || Array.isArray(details.args))
    throw new Error("Request identity/expiry or tool arguments invalid");
  const computed = createHash("sha256").update(JSON.stringify({
    sessionId: details.session_id, tool: details.tool, args: details.args,
  })).digest("hex");
  const expectedSummary = details.tool + ": " + (typeof details.args.command === "string"
    ? details.args.command : JSON.stringify(details.args));
  if (computed !== details.fingerprint || id !== computed.slice(0, 24) || details.summary !== expectedSummary)
    throw new Error("Approval request was tampered with: displayed action and fingerprint disagree");
  message = JSON.stringify({ id: details.id, fingerprint: details.fingerprint, session_id: details.session_id, expires_at: details.expires_at });
  output = path.join(base, id + ".approved.json");
  console.log("TOOL ACTION:\n" + details.summary + "\nFULL ARGUMENTS:\n" + JSON.stringify(details.args, null, 2) + "\n");
  console.log("REQUEST ID: " + id + "\nACTION SHA256: " + details.fingerprint + "\nEXPIRES: " + new Date(details.expires_at).toISOString());
} else {
  details = { session_id: id, expires_at: Date.now() + 60000 };
  message = JSON.stringify(details);
  output = path.join(base, "unlock-" + id + ".json");
  console.log("UNLOCK SESSION: " + id + "\nEXPIRES: " + new Date(details.expires_at).toISOString());
}

if (process.env.POLICYGATE_TEST_OPERATOR !== "1") {
  console.log("Review the full displayed action before approving.");
  const rl = createInterface({ input: stdin, output: stdout });
  let answer = "", timer;
  try {
    answer = await Promise.race([
      rl.question("Type APPROVE " + id + " to continue: "),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Operator approval timeout")), 30000); }),
    ]);
  } finally {
    clearTimeout(timer);
    rl.close();
  }
  if (answer.trim() !== "APPROVE " + id) throw new Error("Operator rejected request");
}

const signature = sign(null, Buffer.from(message), privateKey).toString("base64");
fs.writeFileSync(output, JSON.stringify({ ...details, signature }, null, 2) + "\n", { mode: 0o644, flag: "wx" });
console.log("Operator approval signed once; repeat the exact MCP request before expiry.");
process.exit(0);
