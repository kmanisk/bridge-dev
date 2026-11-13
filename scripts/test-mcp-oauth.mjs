import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileOAuthClientProvider } from "../dist/lib/mcp-oauth-provider.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-oauth-"));
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`OK  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const make = () => new FileOAuthClientProvider({
  serverId: "test-server",
  authDir: dir,
  callbackBase: "http://127.0.0.1:3999",
  openBrowser: false,
});

await test("oauth state persists across provider instances", async () => {
  const a = make();
  await a.beginAuthorization();
  const state = await a.state();
  assert.equal(await a.verifyState(state), true);
  const b = make();
  assert.equal(await b.verifyState(state), true);
  assert.equal(await b.verifyState("wrong"), false);
});

await test("oauth client info, verifier and tokens persist", async () => {
  const a = make();
  await a.saveClientInformation({ client_id: "client-1" });
  await a.saveCodeVerifier("verifier-1");
  await a.saveTokens({ access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1" });
  const b = make();
  assert.equal((await b.clientInformation())?.client_id, "client-1");
  assert.equal(await b.codeVerifier(), "verifier-1");
  assert.equal((await b.tokens())?.access_token, "access-1");
  assert.equal((await b.authorizationStatus()).connected, true);
});

await test("oauth disconnect removes tokens without client registration", async () => {
  const a = make();
  await a.invalidateCredentials("tokens");
  assert.equal(await a.tokens(), undefined);
  assert.equal((await a.clientInformation())?.client_id, "client-1");
});

await test("oauth storage redirects to MCP_OAUTH_STORE env path", async () => {
  const stagingHome = await fs.mkdtemp(path.join(os.tmpdir(), "staging-home-"));
  const stagingStore = path.join(stagingHome, ".mcp-oauth");
  const oldEnv = process.env.MCP_OAUTH_STORE;
  try {
    process.env.MCP_OAUTH_STORE = stagingStore;
    const provider = new FileOAuthClientProvider({
      serverId: "redirected-server",
      callbackBase: "http://127.0.0.1:3999",
      openBrowser: false,
    });
    await provider.saveClientInformation({ client_id: "staging-client-id" });
    const written = path.join(stagingStore, "redirected-server.json");
    const stat = await fs.lstat(written);
    assert.ok(stat.isFile(), "OAuth store file written inside MCP_OAUTH_STORE");
    assert.equal(stat.mode & 0o777, 0o600, "OAuth store file created mode 0600");
  } finally {
    if (oldEnv === undefined) delete process.env.MCP_OAUTH_STORE;
    else process.env.MCP_OAUTH_STORE = oldEnv;
    await fs.rm(stagingHome, { recursive: true, force: true });
  }
});

await test("oauth state validation handles valid, invalid, missing, and replayed state", async () => {
  const provider = make();
  // 1. Before beginAuthorization: no pending state exists
  assert.equal(await provider.verifyState("random"), false);
  assert.equal(await provider.verifyState(undefined), false);
  assert.equal(await provider.verifyState(""), false);

  // 2. Begin authorization generates pending state
  await provider.beginAuthorization();
  const validState = await provider.state();
  assert.ok(typeof validState === "string" && validState.length > 10);

  // 3. Valid state verification succeeds
  assert.equal(await provider.verifyState(validState), true);

  // 4. Invalid state verification fails
  assert.equal(await provider.verifyState("invalid-state-" + Date.now()), false);

  // 5. Missing state verification fails
  assert.equal(await provider.verifyState(undefined), false);
  assert.equal(await provider.verifyState(""), false);

  // 6. Complete authorization consumes the pending state
  await provider.completeAuthorization();

  // 7. Replayed state verification fails (single-use enforced)
  assert.equal(await provider.verifyState(validState), false, "Replayed state must be rejected after completion");
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, 0 failed`);
