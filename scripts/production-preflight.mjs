#!/usr/bin/env node
// Restricted-service STARTUP preflight. Executed as the real service UID.
// Development's verify-audit.mjs intentionally allows a nonexistent first-run
// ledger; production must refuse that state and an unanchored chain.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPolicyConfig } from "../dist/lib/policy-gateway.js";
import { verifyAuditFile } from "../dist/lib/hash-audit.js";

function fail(message) { throw new Error("POLICYGATE_PRODUCTION_PREFLIGHT_FAILED: "+message); }
function requiredAbsolute(key) {
  const value=process.env[key];
  if(!value || !path.isAbsolute(value))fail(key+" must be an absolute path");
  return path.resolve(value);
}
function protectedStat(filename, type, owner, expectedMode) {
  let st;
  try { st=fs.lstatSync(filename); }
  catch { fail(type+" missing or inaccessible: "+filename); }
  if(st.isSymbolicLink() || !(type==="directory" ? st.isDirectory() : st.isFile()))
    fail(type+" is not a regular "+type+": "+filename);
  const allowedOwners = Array.isArray(owner) ? owner : [owner];
  if(!allowedOwners.includes(st.uid))fail(type+" has unexpected owner: "+filename);
  if((st.mode&0o777)!==expectedMode)
    fail(type+" has unexpected mode (required "+expectedMode.toString(8)+"): "+filename);
  return st;
}
export function validateSecureToken(token, name = "token") {
  if (typeof token !== "string" || token.length < 32) {
    fail(`${name} must be a nonempty secret of at least 32 characters`);
  }
  const lower = token.toLowerCase();
  const placeholders = [
    "replace", "changeme", "placeholder", "secret", "password",
    "default", "example", "token", "admin", "sample", "dummy", "test", "todo"
  ];
  for (const ph of placeholders) {
    if (lower.includes(ph)) {
      fail(`${name} contains predictable placeholder pattern: "${ph}"`);
    }
  }
  if (/^(.)\1+$/.test(token)) {
    fail(`${name} contains only repeated identical characters`);
  }
  if (/^(.{1,8})\1+$/.test(token)) {
    fail(`${name} consists of a predictable repeating pattern`);
  }
  const uniqueChars = new Set(token).size;
  if (uniqueChars < 10) {
    fail(`${name} lacks character diversity (${uniqueChars} unique characters; minimum 10 required)`);
  }
  const sequences = [
    "01234567890123456789",
    "abcdefghijklmnopqrstuvwxyz",
    "qwertyuiopasdfghjklzxcvbnm",
  ];
  for (const seq of sequences) {
    for (let i = 0; i <= seq.length - 8; i++) {
      const sub = seq.slice(i, i + 8);
      if (lower.includes(sub)) {
        fail(`${name} contains predictable sequential characters: "${sub}"`);
      }
    }
  }
}

function isWithin(parent,child) {
  return child.startsWith(path.resolve(parent)+path.sep);
}
function main() {
  if(process.argv.length!==2)fail("production preflight accepts no positional overrides");
  if(process.platform!=="linux")fail("Linux restricted-service deployment only");
  const uid=process.getuid?.(),gid=process.getgid?.();
  if(uid===undefined || uid===0 || uid===1000 || os.userInfo().username!=="localcoder")
    fail("must run as an independent, non-root localcoder account, never the login UID");
  if(process.env.POLICYGATE_DANGEROUS==="yes")fail("dangerous mode forbidden");
  const mcpToken=process.env.MCP_TOKEN||"",adminToken=process.env.ADMIN_TOKEN||"";
  validateSecureToken(mcpToken, "MCP_TOKEN");
  validateSecureToken(adminToken, "ADMIN_TOKEN");
  if(mcpToken===adminToken)
    fail("MCP_TOKEN and ADMIN_TOKEN must be independent secrets");
  if(process.env.HOST!=="127.0.0.1" || Number(process.env.PORT)===Number(process.env.ADMIN_PORT))
    fail("MCP and admin must bind distinct explicitly selected localhost ports");
  const cfgFile=requiredAbsolute("POLICYGATE_POLICY_FILE");
  const keyFile=requiredAbsolute("POLICYGATE_APPROVAL_PUBLIC_KEY");
  const privateKey=requiredAbsolute("POLICYGATE_OPERATOR_PRIVATE_KEY");
  const approvalDir=requiredAbsolute("POLICYGATE_APPROVAL_DIR");
  const anchorFile=requiredAbsolute("POLICYGATE_AUDIT_ANCHOR_FILE");
  const envFile=requiredAbsolute("POLICYGATE_ENV_FILE");
  const contextRoot=requiredAbsolute("LOCAL_CODER_CHEZMOI_SOURCE_DIR");
  const upstreamFile=requiredAbsolute("MCP_UPSTREAM_CONFIG");
  const hooksFile=requiredAbsolute("POST_EDIT_HOOKS_CONFIG");
  const homeDir=requiredAbsolute("HOME");
  const shellStateDir=requiredAbsolute("MCP_SHELL_STATE_DIR");
  const oauthStore=requiredAbsolute("MCP_OAUTH_STORE");

  if(!isWithin(homeDir,shellStateDir))
    fail("MCP_SHELL_STATE_DIR must reside within the service home directory: "+shellStateDir);
  if(!isWithin(homeDir,oauthStore))
    fail("MCP_OAUTH_STORE must reside within the service home directory: "+oauthStore);
  if(fs.existsSync(shellStateDir)) {
    protectedStat(shellStateDir,"directory",uid,0o700);
  } else {
    protectedStat(homeDir,"directory",uid,0o700);
  }
  if(fs.existsSync(oauthStore)) {
    protectedStat(oauthStore,"directory",uid,0o700);
  } else {
    protectedStat(homeDir,"directory",uid,0o700);
  }
  try {
    const probe=path.join(homeDir,".preflight-probe-"+Date.now());
    fs.writeFileSync(probe,"ok\n");
    fs.unlinkSync(probe);
  } catch(err) {
    fail("home directory is not writable by service UID: "+String(err));
  }
  const release=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
  protectedStat(release,"directory",0,0o755);
  protectedStat(path.join(release,"dist/index.js"),"file",0,0o644);
  protectedStat(path.join(release,"scripts/production-preflight.mjs"),"file",0,0o644);
  protectedStat(path.join(release,"public/ui"),"directory",0,0o755);
  protectedStat(path.join(release,"public/ui/index.html"),"file",0,0o644);
  protectedStat(path.join(release,"public/ui/app.js"),"file",0,0o644);
  protectedStat(path.join(release,"public/ui/styles.css"),"file",0,0o644);
  protectedStat(path.dirname(cfgFile),"directory",0,0o755);
  protectedStat(cfgFile,"file",0,0o644);
  protectedStat(keyFile,"file",0,0o444);
  protectedStat(privateKey,"file",0,0o400);
  protectedStat(anchorFile,"file",0,0o644);
  protectedStat(envFile,"file",0,0o600);
  protectedStat(upstreamFile,"file",0,0o644);
  protectedStat(hooksFile,"file",0,0o644);
  if(fs.accessSync) {
    try {fs.accessSync(privateKey,fs.constants.R_OK);fail("operator private key is accessible by service UID");}
    catch(e) {if(String(e).includes("POLICYGATE_PRODUCTION_PREFLIGHT_FAILED"))throw e;}
  }
  const upstream=JSON.parse(fs.readFileSync(upstreamFile,"utf8"));
  if(!Array.isArray(upstream.servers) || upstream.servers.some(s=>s.enabled!==false))
    fail("all upstream MCP providers must be disabled during acceptance");
  const hooks=JSON.parse(fs.readFileSync(hooksFile,"utf8"));
  if(hooks.enabled || (hooks.hooks||[]).length)
    fail("post-edit hooks must be disabled during acceptance");
  const cfg=loadPolicyConfig(cfgFile);
  if(!["strict","standard"].includes(cfg.profile) || cfg.dangerous_enabled)
    fail("strict or standard profile with dangerous_enabled=false required");
  protectedStat(contextRoot,"directory",[0, 1000],0o755);
  for(const filename of cfg.context_files) {
    if(!isWithin(contextRoot,filename))fail("canonical context file escapes read-only snapshot root");
    protectedStat(filename,"file",[0, 1000],0o644);
  }
  for(const root of cfg.writable_roots) {
    if(!isWithin("/srv/local-coder",root) && !isWithin("/srv/local-coder-policygate-staging",root))
      fail("writable roots must be inside the designated disposable workspace");
    const st=protectedStat(root,"directory",uid,0o700);
    if(st.gid!==gid)fail("workspace GID mismatch");
  }
  if(!cfg.hard_paths.some(p=>p===release || isWithin(p,release)) ||
     !cfg.hard_paths.some(p=>p===path.dirname(cfgFile) || isWithin(p,path.dirname(cfgFile))) ||
     !cfg.hard_paths.some(p=>p===contextRoot || isWithin(p,contextRoot)) ||
     !cfg.hard_paths.some(p=>p===path.dirname(cfg.audit_log) || isWithin(p,path.dirname(cfg.audit_log))))
    fail("hard_paths must cover executable, policy, context and audit locations");
  protectedStat(approvalDir,"directory",uid,0o700);
  if(cfg.audit_log!==path.resolve(cfg.audit_log))fail("ledger path is not absolute");
  const auditDir=protectedStat(path.dirname(cfg.audit_log),"directory",0,0o750);
  const ledger=protectedStat(cfg.audit_log,"file",0,0o660);
  if(auditDir.gid!==gid || ledger.gid!==gid)fail("audit directory/ledger GID is not the service GID");
  let flags;
  try {flags=execFileSync("/usr/bin/lsattr",["-d","--",cfg.audit_log],{encoding:"utf8",timeout:3000}).trim().split(/\s+/)[0];}
  catch {fail("cannot verify filesystem append-only attribute");}
  if(!flags.includes("a"))fail("ledger lacks verified append-only filesystem attribute");
  const verified=verifyAuditFile(cfg.audit_log);
  const anchor=JSON.parse(fs.readFileSync(anchorFile,"utf8"));
  if(!Number.isSafeInteger(anchor.entries) || anchor.entries<0 || anchor.entries>verified.entries ||
     typeof anchor.last_hash!=="string" || !/^[a-f0-9]{64}$/.test(anchor.last_hash))
    fail("trusted audit-chain anchor invalid");
  const anchoredHash=anchor.entries===0?"0".repeat(64):
    JSON.parse(fs.readFileSync(cfg.audit_log,"utf8").split("\n")[anchor.entries-1]).hash;
  if(anchor.last_hash!==anchoredHash)fail("audit chain differs from trusted root-owned anchor");
  console.log(JSON.stringify({ok:true,restricted_uid:uid,profile:cfg.profile,ledger_entries:verified.entries,
    anchor_entries:anchor.entries,append_only:true,context_files:cfg.context_files.length}));
}
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntry) {
  try {main();} catch(e) {console.error(String(e));process.exitCode=1;}
}
