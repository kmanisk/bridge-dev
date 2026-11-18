#!/usr/bin/env node
/**
 * Mock Stdio MCP Provider for Benchmark Harness
 * Responds to initialize, tools/list, and tools/call.
 */
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    const id = req.id;

    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-provider", version: "1.0.0" },
        },
      });
    } else if (req.method === "notifications/initialized") {
      // Notification, no response
    } else if (req.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "mock_echo",
              description: "Echo back message",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
            {
              name: "mock_work",
              description: "Simulate small compute workload",
              inputSchema: {
                type: "object",
                properties: { iterations: { type: "number" } },
              },
            },
          ],
        },
      });
    } else if (req.method === "tools/call") {
      const name = req.params?.name;
      const args = req.params?.arguments || {};
      if (name === "mock_echo") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `echo: ${args.message}` }],
          },
        });
      } else if (name === "mock_work") {
        let sum = 0;
        const it = args.iterations || 1000;
        for (let i = 0; i < it; i++) sum += i;
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `result: ${sum}` }],
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Tool not found: ${name}` },
        });
      }
    } else {
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
      }
    }
  } catch (err) {
    // Ignore invalid JSON
  }
});
