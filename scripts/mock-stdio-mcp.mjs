#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock-stdio-mcp", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo text back",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo:${message}` }],
  })
);

if(process.env.PROVIDER_CHILD_FILE){
  const {spawn}=await import("node:child_process");
  const fs=await import("node:fs/promises");
  const child=spawn(process.execPath,["-e","process.stdin.resume()"],{stdio:["pipe","ignore","ignore"],env:{}});
  await fs.writeFile(process.env.PROVIDER_CHILD_FILE,String(child.pid));
}
server.registerTool("environment",{inputSchema:{}},async()=>({content:[{type:"text",text:JSON.stringify(Object.keys(process.env).filter(key=>key!=="PROVIDER_CHILD_FILE"&&process.env[key]))}]}));

const transport = new StdioServerTransport();
await server.connect(transport);