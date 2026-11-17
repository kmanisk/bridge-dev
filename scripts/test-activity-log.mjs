import assert from "node:assert/strict";
import { appendActivity, getRecentActivity, getActiveMcpTools, beginMcpToolRequest,
  completeMcpToolRequest, logMcpRequest, summarizeToolArgs } from "../dist/lib/activity-log.js";

// summarizeToolArgs
assert.equal(summarizeToolArgs("run_command", { command: "npm test" }), "npm test");
assert.equal(summarizeToolArgs("read_text_file", { path: "C:\\foo.ts" }), "C:\\foo.ts");

// append + retrieve
const before = getRecentActivity(500).length;
appendActivity({ kind: "tool", tool: "grep", status: "ok", summary: "pattern: foo" });
assert.equal(getRecentActivity(500).length, before + 1);
const latest = getRecentActivity(1)[0];
assert.equal(latest.tool, "grep");
assert.equal(latest.kind, "tool");

// logMcpRequest tools/call
logMcpRequest(
  { method: "tools/call", params: { name: "read_text_file", arguments: { path: "/tmp/x" } } },
  "sess-abc-123",
  42,
  200
);
const mcp = getRecentActivity(5).find((e) => e.kind === "mcp" && e.tool === "read_text_file");
assert.ok(mcp, "expected mcp tools/call entry");
assert.equal(mcp.client, "chatgpt");
assert.equal(mcp.duration_ms, 42);
assert.equal(mcp.summary, "/tmp/x");

// filter since
const all = getRecentActivity(500);
const since = all[1]?.id;
if (since) {
  const newer = getRecentActivity(500, since);
  assert.ok(newer.length < all.length);
}

// error logging with message
logMcpRequest(
  { method: "tools/call", params: { name: "write_file", arguments: { path: "/x" } } },
  "sess-err",
  2,
  400,
  "Bad Request: Server not initialized"
);
const errEntry = getRecentActivity(3).find((e) => e.status === "error" && e.tool === "write_file");
assert.ok(errEntry, "expected error activity entry");
assert.equal(errEntry.summary, "Bad Request: Server not initialized");

const tokenBefore=process.env.MCP_TOKEN;process.env.MCP_TOKEN="activity-private-value-not-for-clients";
appendActivity({kind:"mcp",summary:"activity-private-value-not-for-clients",details:{arbitrary:"activity-private-value-not-for-clients",Authorization:"Bearer private-credential"}});
assert.doesNotMatch(JSON.stringify(getRecentActivity(1)),/activity-private-value-not-for-clients|private-credential/);
if(tokenBefore===undefined)delete process.env.MCP_TOKEN;else process.env.MCP_TOKEN=tokenBefore;
// Start events are visible before execution finishes; they are ephemeral,
// keyed by a generated request ID, and never claim full ChatGPT task state.
const runningBody={method:"tools/call",params:{name:"run_command",arguments:{command:"sensitive input"}}};
const started=beginMcpToolRequest(runningBody,"active-session");
assert.match(started,/^[a-f0-9-]{36}$/);
assert.equal(getActiveMcpTools().length,1);
const startedEvent=getRecentActivity(1)[0];
assert.equal(startedEvent.status,"running");
assert.equal(startedEvent.tool,"run_command");
assert.equal(startedEvent.details.request_id,started);
assert.doesNotMatch(JSON.stringify(startedEvent),/sensitive input/);
logMcpRequest(runningBody,"active-session",97,200,undefined,started);
completeMcpToolRequest(started);
assert.equal(getActiveMcpTools().length,0);
const completed=getRecentActivity(2)[0];
assert.equal(completed.details.request_id,started);
assert.equal(completed.status,"ok");
const dropped=beginMcpToolRequest(runningBody,"drop-session");
completeMcpToolRequest(dropped,true);
assert.equal(getRecentActivity(1)[0].status,"interrupted");
assert.equal(getActiveMcpTools().length,0);
assert.equal(beginMcpToolRequest({method:"tools/list"},undefined),undefined);
assert.equal(getActiveMcpTools().length,0);
console.log("activity-log: ok");