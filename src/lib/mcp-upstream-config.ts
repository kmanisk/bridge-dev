import fs from "fs/promises";
import path from "path";
import os from "os";
import {atomicJson,withFileLock} from "./atomic-store.js";
import { getRuntimeMode } from "./runtime.js";

export type UpstreamTransport = "stdio" | "http";
export type UpstreamExposeMode = "none" | "meta_only" | "allowlist" | "all";
export type UpstreamAuthMode = "auto" | "oauth" | "none";

export interface UpstreamAuthConfig {
  type: UpstreamAuthMode;
  scope?: string;
}

export interface UpstreamServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: UpstreamTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  bearer_token_env_var?: string;
  auth?: UpstreamAuthConfig;
  tool_prefix?: string;
  expose: UpstreamExposeMode;
  tools?: string[];
  disabled_tools?: string[];
  idle_timeout_sec?: number;
  allow_private_network?: boolean;
  tool_permissions?: Record<string,"R"|"W"|"X">;
  reviewed?: boolean;
}

export interface UpstreamConfigFile {
  version: 1;
  servers: UpstreamServerConfig[];
}

const CONFIG_VERSION = 1 as const;

export function defaultUpstreamConfig(): UpstreamConfigFile {
  return { version: CONFIG_VERSION, servers: [] };
}

export function resolveUpstreamConfigPath(): string {
  const configured = process.env.MCP_UPSTREAM_CONFIG?.trim();
  if (configured) return path.resolve(configured);
  return getRuntimeMode() === "portable"
    ? path.resolve(process.env.WORKSPACE_PATH?.split(";")[0] || process.cwd(), ".bridge-dev", "mcp.json")
    : path.resolve(process.cwd(), "profiles", "mcp-upstream.json");
}

function normalizeServer(raw: UpstreamServerConfig): UpstreamServerConfig {
  if(!raw || typeof raw!=="object" || Array.isArray(raw) || typeof raw.id!=="string")throw new Error("Invalid provider object or id");
  for(const key of ["name","command","cwd","url","bearer_token_env_var","tool_prefix"] as const)if(raw[key]!==undefined&&typeof raw[key]!=="string")throw new Error("Invalid provider field: "+key);
  for(const key of ["enabled","allow_private_network","reviewed"] as const)if(raw[key]!==undefined&&typeof raw[key]!=="boolean")throw new Error("Invalid provider field: "+key);
  for(const key of ["tools","disabled_tools"] as const)if(raw[key]!==undefined&&(!Array.isArray(raw[key])||!raw[key]!.every(x=>typeof x==="string")))throw new Error("Invalid provider field: "+key);
  for(const key of ["env","headers","tool_permissions"] as const)if(raw[key]!==undefined&&(!raw[key]||typeof raw[key]!=="object"||Array.isArray(raw[key])||!Object.values(raw[key]!).every(x=>typeof x==="string")))throw new Error("Invalid provider field: "+key);
  if(raw.auth!==undefined&&(!raw.auth||typeof raw.auth!=="object"||!["auto","oauth","none"].includes(raw.auth.type)||Object.keys(raw.auth).some(k=>!["type","scope"].includes(k))||(raw.auth.scope!==undefined&&typeof raw.auth.scope!=="string")))throw new Error("Invalid provider auth");
  if(raw.idle_timeout_sec!==undefined&&(!Number.isFinite(raw.idle_timeout_sec)||raw.idle_timeout_sec<0))throw new Error("Invalid provider idle timeout");
  const id = raw.id.trim();
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id)) throw new Error("Upstream server id must contain 1-48 safe characters");
  if(raw.args!==undefined && (!Array.isArray(raw.args) || !raw.args.every(x=>typeof x==="string")))throw new Error("Invalid provider arguments");
  if(raw.expose!==undefined && !["none","meta_only","allowlist","all"].includes(raw.expose))throw new Error("Invalid exposure");
  if(raw.tool_prefix && !/^[a-zA-Z0-9_-]{1,48}$/.test(raw.tool_prefix))throw new Error("Invalid tool prefix");

  for(const [tool,permission]of Object.entries(raw.tool_permissions||{}))if(!tool||!["R","W","X"].includes(permission))throw new Error("Invalid per-tool permission");
  if(raw.url){let url:URL;try{url=new URL(raw.url);}catch{throw new Error("Invalid provider URL");}if(url.username||url.password||!["https:","http:"].includes(url.protocol))throw new Error("Invalid provider URL or embedded credentials");}
  for(const value of Object.values(raw.env||{}))if(typeof value!=="string")throw new Error("Invalid provider environment");
  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid transport for provider ${id}`);
  }

  if (transport === "stdio" && !raw.command?.trim()) {
    throw new Error(`stdio server ${id} requires command`);
  }
  if (transport === "http" && !raw.url?.trim()) {
    throw new Error(`http server ${id} requires url`);
  }

  return {
    id,
    name: raw.name?.trim() || id,
    enabled: raw.enabled === true,
    transport,
    command: raw.command?.trim(),
    args: raw.args ?? [],
    env: {...(process.platform==="win32"?{SYSTEMROOT:process.env.SystemRoot||process.env.SYSTEMROOT||"",WINDIR:process.env.WINDIR||process.env.SystemRoot||process.env.SYSTEMROOT||""}:{}),...(raw.env??{})},
    cwd: raw.cwd?.trim(),
    url: raw.url?.trim(),
    headers: raw.headers ?? {},
    bearer_token_env_var: raw.bearer_token_env_var?.trim(),
    auth: raw.auth ?? { type: transport === "http" ? "auto" : "none" },
    tool_prefix: (raw.tool_prefix?.trim() || id).replace(/[^a-zA-Z0-9_-]/g, "_"),
    // Discovery never grants exposure. Existing explicit allowlists remain valid.
    expose: raw.expose ?? "none",
    tools: raw.tools ?? [],
    disabled_tools: raw.disabled_tools ?? [],
    idle_timeout_sec: raw.idle_timeout_sec ?? 600,
    allow_private_network: raw.allow_private_network === true,
    tool_permissions: raw.tool_permissions ?? {},
    ...(raw.reviewed!==undefined?{reviewed:raw.reviewed}:{}),
  };
}

export function normalizeConfig(config: UpstreamConfigFile):UpstreamConfigFile {
  if(config.version!==1 || !Array.isArray(config.servers) || config.servers.length>64)throw new Error("Invalid upstream config schema");
  const servers=config.servers.map(normalizeServer);
  const ids=new Set<string>(),prefixes=new Set<string>();
  for(const server of servers){
    if(ids.has(server.id)||prefixes.has(server.tool_prefix!))throw new Error("PROVIDER_NAMESPACE_COLLISION");
    ids.add(server.id);prefixes.add(server.tool_prefix!);
  }
  return {version:1,servers};
}

export interface UpstreamConfigDetails {
  config: UpstreamConfigFile;
  document: UpstreamConfigFile;
  source_schema: "v1" | "legacy-unversioned" | "missing";
  migration_required: boolean;
}
const PROVIDER_FIELDS=new Set(["id","name","enabled","transport","command","args","env","cwd","url","headers","bearer_token_env_var","auth","tool_prefix","expose","tools","disabled_tools","idle_timeout_sec","allow_private_network","tool_permissions","reviewed"]);
export function parseUpstreamConfig(raw: string): UpstreamConfigDetails {
  if(!raw.trim())throw new Error("UPSTREAM_CONFIG_EMPTY: expected a version-1 registry or an unversioned servers array");
  if(Buffer.byteLength(raw)>4*1048576)throw new Error("UPSTREAM_CONFIG_SIZE_LIMIT");
  let parsed:any;
  try{parsed=JSON.parse(raw);}catch{throw new Error("UPSTREAM_CONFIG_JSON_INVALID: malformed JSON");}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("UPSTREAM_CONFIG_SCHEMA_INVALID: expected an object");
  const legacy=!Object.hasOwn(parsed,"version");
  if(!legacy&&parsed.version!==1)throw new Error("UPSTREAM_CONFIG_VERSION_UNSUPPORTED: expected version 1; only a missing version with servers is supported as legacy");
  if(Object.keys(parsed).some(k=>!["version","servers"].includes(k))||!Array.isArray(parsed.servers)||parsed.servers.length>64)throw new Error("UPSTREAM_CONFIG_SCHEMA_INVALID: expected only version and a servers array");
  const servers=parsed.servers.map((server:any,index:number)=>{
    if(!server||typeof server!=="object"||Array.isArray(server))throw new Error("UPSTREAM_PROVIDER_INVALID: servers["+index+"] must be an object");
    if(Object.keys(server).some(k=>!PROVIDER_FIELDS.has(k)))throw new Error("UPSTREAM_PROVIDER_INVALID: servers["+index+"] has unsupported fields; no provider was dropped");
    if(legacy)for(const key of ["id","name","command","cwd","url","bearer_token_env_var","tool_prefix"])if(typeof server[key]==="string"&&server[key]!==server[key].trim())throw new Error("UPSTREAM_PROVIDER_INVALID: servers["+index+"]."+key+" has surrounding whitespace; operator review required");
    try{normalizeServer(server);}catch(error){throw new Error("UPSTREAM_PROVIDER_INVALID: servers["+index+"]: "+(error as Error).message);}
    return legacy&&server.reviewed!==true?{...server,enabled:false,expose:"none"}:{...server};
  });
  const document:UpstreamConfigFile={version:1,servers};
  let config:UpstreamConfigFile;
  try{config=normalizeConfig(document);}catch(error){throw new Error("UPSTREAM_CONFIG_PROVIDER_INVALID: "+(error as Error).message+"; no provider was dropped");}
  return {config,document,source_schema:legacy?"legacy-unversioned":"v1",migration_required:legacy};
}
export async function loadUpstreamConfigDetails(configPath = resolveUpstreamConfigPath()): Promise<UpstreamConfigDetails> {
  try {
    const st=await fs.lstat(configPath);
    if(!st.isFile()||st.isSymbolicLink()||st.size>4*1048576)throw new Error("UPSTREAM_CONFIG_UNSAFE_PATH_OR_SIZE");
    const raw = await fs.readFile(configPath, "utf-8");
    return parseUpstreamConfig(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const defaults = defaultUpstreamConfig();
      return {config:defaults,document:defaults,source_schema:"missing",migration_required:false};
    }
    throw err;
  }
}
export async function loadUpstreamConfig(configPath = resolveUpstreamConfigPath()): Promise<UpstreamConfigFile> {
  return (await loadUpstreamConfigDetails(configPath)).config;
}
export async function requireCurrentUpstreamConfig(configPath:string):Promise<UpstreamConfigFile>{
  const loaded=await loadUpstreamConfigDetails(configPath);
  if(loaded.migration_required)throw new Error("UPSTREAM_MIGRATION_REQUIRED: run bridge-dev mcp migrate as an operator; legacy files are read-only at runtime");
  return loaded.config;
}

export async function saveUpstreamConfig(
  config: UpstreamConfigFile,
  configPath = resolveUpstreamConfigPath()
): Promise<void> {
  const normalized = normalizeConfig(config);
  await withFileLock(configPath,async()=>{await requireCurrentUpstreamConfig(configPath);await atomicJson(configPath,normalized);});
}

export type McpImportSource = "cursor" | "claude" | "opencode" | "file";

export interface McpServersEntry {
  command?: string;
  args?: string[] | string;
  env?: Record<string, string>;
  environment?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
  transport?: string;
  headers?: Record<string, string>;
  bearer_token_env_var?: string;
  auth?: UpstreamAuthConfig;
  enabled?: boolean;
}

export interface DiscoveredMcpConfig {
  source: McpImportSource;
  path: string;
  label: string;
  server_count: number;
}

const HTTP_TYPES = new Set(["http", "streamable-http", "sse", "remote"]);
const STDIO_TYPES = new Set(["stdio", "local"]);

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

function commandToParts(command: string | string[] | undefined): { command?: string; args: string[] } {
  if (!command) return { args: [] };
  if (Array.isArray(command)) {
    return { command: command[0], args: command.slice(1) };
  }
  return { command, args: [] };
}

function resolveTransport(entry: McpServersEntry): UpstreamTransport | null {
  const type = (entry.type || entry.transport || "").toLowerCase();
  const hasUrl = Boolean(entry.url?.trim());
  const cmdParts = commandToParts(entry.command as string | string[] | undefined);
  const hasCommand = Boolean(cmdParts.command?.trim());

  if (HTTP_TYPES.has(type) || hasUrl) return "http";
  if (STDIO_TYPES.has(type) || hasCommand) return "stdio";
  if (type === "ws") return null;
  if (hasUrl) return "http";
  if (hasCommand) return "stdio";
  return null;
}

function entryToServer(id: string, entry: McpServersEntry, enabledDefault = false): UpstreamServerConfig | null {
  const transport = resolveTransport(entry);
  if (!transport) return null;

  const cmdParts = commandToParts(entry.command as string | string[] | undefined);
  const args = Array.isArray(entry.args) ? entry.args : entry.args ? [entry.args] : cmdParts.args;
  const env = { ...(entry.env ?? {}), ...(entry.environment ?? {}) };

  return normalizeServer({
    id,
    name: id,
    enabled: false,
    transport,
    command: cmdParts.command,
    args,
    env: Object.keys(env).length ? env : undefined,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
    bearer_token_env_var: entry.bearer_token_env_var,
    auth: entry.auth,
    expose: "none",
    tools: [],
  });
}

export function parseMcpServersRecord(
  servers: Record<string, McpServersEntry>,
  enabledDefault = false
): UpstreamServerConfig[] {
  const imported: UpstreamServerConfig[] = [];
  for (const [id, entry] of Object.entries(servers)) {
    const server = entryToServer(id, entry, enabledDefault);
    if (server) imported.push(server);
  }
  return imported;
}

export interface McpServersFile {
  mcpServers?: Record<string, McpServersEntry>;
}

export function parseMcpServersFile(raw: McpServersFile, enabledDefault = false): UpstreamServerConfig[] {
  return parseMcpServersRecord(raw.mcpServers ?? {}, enabledDefault);
}

export interface ClaudeCodeConfigFile {
  mcpServers?: Record<string, McpServersEntry>;
  projects?: Record<string, { mcpServers?: Record<string, McpServersEntry> }>;
}

export function parseClaudeCodeConfig(raw: ClaudeCodeConfigFile, enabledDefault = false): UpstreamServerConfig[] {
  const merged: Record<string, McpServersEntry> = { ...(raw.mcpServers ?? {}) };
  for (const project of Object.values(raw.projects ?? {})) {
    if (project?.mcpServers) Object.assign(merged, project.mcpServers);
  }
  return parseMcpServersRecord(merged, enabledDefault);
}

export interface OpenCodeMcpEntry {
  type?: "local" | "remote" | string;
  command?: string | string[];
  url?: string;
  cwd?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  bearer_token_env_var?: string;
  auth?: UpstreamAuthConfig;
  enabled?: boolean;
}

export interface OpenCodeConfigFile {
  mcp?: Record<string, OpenCodeMcpEntry>;
}

export function parseOpenCodeConfig(raw: OpenCodeConfigFile, enabledDefault = false): UpstreamServerConfig[] {
  const imported: UpstreamServerConfig[] = [];
  for (const [id, entry] of Object.entries(raw.mcp ?? {})) {
    const cmdParts = commandToParts(entry.command);
    const mapped: McpServersEntry = {
      type: entry.type === "remote" ? "http" : entry.type === "local" ? "stdio" : entry.type,
      command: cmdParts.command,
      args: cmdParts.args,
      url: entry.url,
      cwd: entry.cwd,
      environment: entry.environment,
      headers: entry.headers,
      bearer_token_env_var: entry.bearer_token_env_var,
      auth: entry.auth,
      enabled: entry.enabled,
    };
    const server = entryToServer(id, mapped, enabledDefault);
    if (server) imported.push(server);
  }
  return imported;
}

async function mergeImportedServers(
  incoming: UpstreamServerConfig[],
  options?: { merge?: boolean; enableImported?: boolean }
): Promise<{ imported: string[]; config: UpstreamConfigFile }> {
  const configPath = resolveUpstreamConfigPath();
  const existing = await loadUpstreamConfig(configPath);
  const merge = options?.merge !== false;
  const byId = new Map(existing.servers.map((s) => [s.id, s]));
  const imported: string[] = [];

  for (const server of incoming) {
    if (options?.enableImported) server.enabled = true;
    if (merge && byId.has(server.id)) continue;
    byId.set(server.id, server);
    imported.push(server.id);
  }

  const merged: UpstreamConfigFile = { version: CONFIG_VERSION, servers: [...byId.values()] };
  await saveUpstreamConfig(merged, configPath);
  return { imported, config: merged };
}

export async function importMcpConfigFromFile(
  filePath: string,
  source: McpImportSource,
  options?: { merge?: boolean; enableImported?: boolean }
): Promise<{ imported: string[]; config: UpstreamConfigFile; source: McpImportSource; path: string }> {
  const rawText = await fs.readFile(filePath, "utf-8");
  const parsed = parseJsonc(rawText);
  let incoming: UpstreamServerConfig[] = [];

  if (source === "opencode") {
    incoming = parseOpenCodeConfig(parsed as OpenCodeConfigFile, false);
  } else if (source === "claude") {
    incoming = parseClaudeCodeConfig(parsed as ClaudeCodeConfigFile, false);
  } else {
    incoming = parseMcpServersFile(parsed as McpServersFile, false);
  }

  const result = await mergeImportedServers(incoming, options);
  return { ...result, source, path: filePath };
}

export async function importCursorMcpConfig(
  cursorConfigPath: string,
  options?: { merge?: boolean; enableImported?: boolean }
) {
  return importMcpConfigFromFile(cursorConfigPath, "cursor", options);
}

function homePaths(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

export function discoveryCandidates(): Array<{ source: McpImportSource; path: string; label: string }> {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const cwd = process.cwd();

  return [
    { source: "cursor", path: path.join(home, ".cursor", "mcp.json"), label: "Cursor (~/.cursor/mcp.json)" },
    { source: "cursor", path: path.join(appData, "Cursor", "User", "mcp.json"), label: "Cursor (AppData)" },
    { source: "claude", path: homePaths(".claude.json"), label: "Claude Code (~/.claude.json)" },
    { source: "claude", path: path.join(cwd, ".mcp.json"), label: "Claude Code (project .mcp.json)" },
    { source: "claude", path: path.join(appData, "Claude", "claude_desktop_config.json"), label: "Claude Desktop" },
    { source: "opencode", path: homePaths(".config", "opencode", "opencode.json"), label: "OpenCode (global)" },
    { source: "opencode", path: homePaths(".config", "opencode", "opencode.jsonc"), label: "OpenCode (global jsonc)" },
    { source: "opencode", path: path.join(cwd, "opencode.json"), label: "OpenCode (project)" },
    { source: "opencode", path: path.join(cwd, "opencode.jsonc"), label: "OpenCode (project jsonc)" },
    { source: "opencode", path: path.join(programData, "opencode", "opencode.json"), label: "OpenCode (managed)" },
  ];
}

export async function discoverMcpConfigs(): Promise<DiscoveredMcpConfig[]> {
  const found: DiscoveredMcpConfig[] = [];
  const seen = new Set<string>();

  for (const candidate of discoveryCandidates()) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      await fs.access(candidate.path);
      const rawText = await fs.readFile(candidate.path, "utf-8");
      const parsed = parseJsonc(rawText);
      let count = 0;
      if (candidate.source === "opencode") count = Object.keys((parsed as OpenCodeConfigFile).mcp ?? {}).length;
      else if (candidate.source === "claude") count = parseClaudeCodeConfig(parsed as ClaudeCodeConfigFile).length;
      else count = Object.keys((parsed as McpServersFile).mcpServers ?? {}).length;
      if (count > 0) found.push({ source: candidate.source, path: candidate.path, label: candidate.label, server_count: count });
    } catch {}
  }
  return found;
}

export async function findMcpConfigForSource(source: McpImportSource): Promise<string | null> {
  const configs = await discoverMcpConfigs();
  return configs.find((c) => c.source === source)?.path ?? null;
}

export async function findCursorMcpConfig(): Promise<string | null> {
  return findMcpConfigForSource("cursor");
}
