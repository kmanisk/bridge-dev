import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {withFileLock,atomicJson} from "./atomic-store.js";
import {ProviderTransport} from "./provider-transport.js";
import {safeFetch} from "./safe-network.js";
import {validateToolArguments,validateToolMetadata,sanitizeProviderResult,proxyToolName} from "./provider-security.js";
import {getPolicyGate} from "./policy-gateway.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  loadUpstreamConfigDetails, requireCurrentUpstreamConfig,
  saveUpstreamConfig,
  type UpstreamConfigFile,
  type UpstreamServerConfig,
  resolveUpstreamConfigPath,
  normalizeConfig,
} from "./mcp-upstream-config.js";
import { FileOAuthClientProvider } from "./mcp-oauth-provider.js";

export type UpstreamHealth = "unknown" | "connected" | "reachable" | "unreachable" | "disabled";

export interface UpstreamServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  transport: string;
  auth: string;
  health: UpstreamHealth;
  connected: boolean;
  tool_count: number;
  expose: string;
  proxied_tools: string[];
  last_error?: string;
  pid?: number | null;
}

interface UpstreamConnection {
  config: UpstreamServerConfig;
  client: Client;
  transport: ProviderTransport | StreamableHTTPClientTransport;
  tools: Tool[];
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastError?: string;
  connected: boolean;
}

let singleton: McpUpstreamManager | null = null;

export class McpUpstreamManager {
  private config: UpstreamConfigFile;
  private configPath: string;
  private connections = new Map<string, UpstreamConnection>();
  private connecting = new Map<string, Promise<UpstreamConnection>>();
  private servers = new Set<McpServer>();
  private toolsCache = new Map<string, { tools: Tool[]; expiresAt: number }>();
  private oauthProviders = new Map<string, FileOAuthClientProvider>();
  private generation=0;
  private failures=new Map<string,{until:number;count:number;error:string}>();
  private readonly toolsCacheTtlMs = 60_000;
  private readonly connectTimeoutMs = Math.max(1_000, Number(process.env.MCP_UPSTREAM_CONNECT_TIMEOUT_MS) || 15_000);

  constructor(configPath = resolveUpstreamConfigPath()) {
    this.configPath = configPath;
    this.config = { version: 1, servers: [] };
  }

  initializationError?: string;
  configuration:{source_schema:string;migration_required:boolean}={source_schema:"missing",migration_required:false};
  private async loadConfiguration():Promise<void>{
    const loaded=await loadUpstreamConfigDetails(this.configPath);this.config=loaded.config;this.configuration={source_schema:loaded.source_schema,migration_required:loaded.migration_required};
  }
  async init(): Promise<void> {
    try { await this.loadConfiguration(); }
    catch (error) { this.initializationError = String(error); this.config = {version:1,servers:[]}; }
    if(!this.initializationError){
      try{
        const {ExtensionStore}=await import("./extension-store.js");
        const owned=(await new ExtensionStore().list()).filter(entry=>entry.component.kind==="mcp"&&entry.component.provider);
        const map=new Map(this.config.servers.map(server=>[server.id,server]));
        for(const entry of owned)map.set(entry.component.id,entry.component.provider!);
        this.config=normalizeConfig({version:1,servers:[...map.values()]});
      }catch(error){this.initializationError="Optional extension registry: "+String(error);}
    }
    this.syncPermissions();
  }

  private syncPermissions():void{
    const permissions:Record<string,"R"|"W"|"X">={};
    for(const config of this.config.servers)if(config.enabled)for(const [name,kind]of Object.entries(config.tool_permissions||{}))if(config.expose==="all"||config.tools?.includes(name))permissions[proxyToolName(config.tool_prefix||config.id,name)]=kind;
    getPolicyGate().setProviderPermissions(permissions);
  }
  registerMcpServer(server: McpServer): void {
    this.servers.add(server);
  }

  unregisterMcpServer(server: McpServer): void {
    this.servers.delete(server);
  }

  getConfig(): UpstreamConfigFile {
    return structuredClone(this.config);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  listServerConfigs(): UpstreamServerConfig[] {
    return structuredClone(this.config.servers);
  }

  getServerConfig(serverId: string): UpstreamServerConfig | undefined {
    return structuredClone(this.config.servers.find((s) => s.id === serverId));
  }

  async reloadConfig(): Promise<UpstreamConfigFile> {
    await this.shutdown();
    await this.loadConfiguration();
    this.initializationError=undefined;
    this.oauthProviders.clear();
    this.syncPermissions();
    await this.refreshAllProxies();
    return structuredClone(this.config);
  }

  async updateConfig(next: UpstreamConfigFile): Promise<UpstreamConfigFile> {
    next=normalizeConfig(next);
    await saveUpstreamConfig(next, this.configPath);
    this.config = structuredClone(next);
    this.configuration={source_schema:"v1",migration_required:false};
    await this.shutdown();
    this.oauthProviders.clear();
    this.syncPermissions();
    await this.refreshAllProxies();
    return structuredClone(this.config);
  }

  async upsertServer(server: UpstreamServerConfig): Promise<void> {
    await withFileLock(this.configPath,async()=>{
      const current=await requireCurrentUpstreamConfig(this.configPath);
      const next=normalizeConfig({version:1,servers:[...current.servers.filter(item=>item.id!==server.id),server]});
      await atomicJson(this.configPath,next);
    });
    await this.reloadConfig();
  }

  async removeServer(serverId: string): Promise<boolean> {
    let removed=false;
    await withFileLock(this.configPath,async()=>{
      const current=await requireCurrentUpstreamConfig(this.configPath);
      const servers=current.servers.filter(item=>item.id!==serverId);
      removed=servers.length!==current.servers.length;
      if(removed)await atomicJson(this.configPath,{version:1,servers});
    });
    await this.reloadConfig();
    return removed;
  }

  private async disconnectDisabled(): Promise<void> {
    const enabledIds = new Set(this.config.servers.filter((s) => s.enabled).map((s) => s.id));
    for (const id of [...this.connections.keys()]) {
      if (!enabledIds.has(id)) await this.disconnect(id);
    }
  }

  private getEnabledServers(): UpstreamServerConfig[] {
    return this.config.servers.filter((s) => s.enabled);
  }

  private scheduleIdleDisconnect(serverId: string, conn: UpstreamConnection): void {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    const timeoutSec = conn.config.idle_timeout_sec ?? 600;
    if (timeoutSec <= 0) return;
    conn.idleTimer = setTimeout(() => {
      void this.disconnect(serverId);
    }, timeoutSec * 1000);
  }

  private touch(conn: UpstreamConnection): void {
    conn.lastUsedAt = Date.now();
    this.scheduleIdleDisconnect(conn.config.id, conn);
  }

  private shouldUseOAuth(config: UpstreamServerConfig): boolean {
    if (config.transport !== "http") return false;
    const mode = config.auth?.type ?? "auto";
    if (mode === "none") return false;
    if (mode === "oauth") return true;
    const hasHeaders = Object.keys(config.headers ?? {}).length > 0;
    return !hasHeaders && !config.bearer_token_env_var;
  }

  private getOAuthProvider(config: UpstreamServerConfig): FileOAuthClientProvider {
    let provider = this.oauthProviders.get(config.id);
    if (!provider) {
      provider = new FileOAuthClientProvider({
        serverId: config.id,
        scope: config.auth?.scope,
        openBrowser: false,
      });
      this.oauthProviders.set(config.id, provider);
    }
    return provider;
  }

  async oauthStatus(serverId: string) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (!this.shouldUseOAuth(config)) {
      return { configured: false, connected: false, pending: false, auth: config.auth?.type ?? "none" };
    }
    return { ...(await this.getOAuthProvider(config).authorizationStatus()), auth: config.auth?.type ?? "auto" };
  }

  async startOAuth(serverId: string, resetTokens = true) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (config.transport !== "http" || !config.url) throw new Error(`OAuth requires an HTTP upstream: ${serverId}`);
    if (!this.shouldUseOAuth(config)) throw new Error(`OAuth is disabled or static auth is configured for ${serverId}`);

    await this.disconnect(serverId);
    const provider = this.getOAuthProvider(config);
    await provider.beginAuthorization({ resetTokens });
    const result = await auth(provider, { serverUrl: config.url, scope: config.auth?.scope, fetchFn:safeFetch(config.allow_private_network===true) });
    const status = await provider.authorizationStatus();
    return { ...status, result };
  }

  async finishOAuth(serverId: string, authorizationCode: string, state?: string) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (config.transport !== "http" || !config.url) throw new Error(`OAuth requires an HTTP upstream: ${serverId}`);
    const provider = this.getOAuthProvider(config);
    if (!(await provider.verifyState(state))) throw new Error("OAuth state mismatch or expired authorization flow");

    const result = await auth(provider, {
      serverUrl: config.url,
      authorizationCode,
      fetchFn:safeFetch(config.allow_private_network===true),
      scope: config.auth?.scope,
    });
    if (result !== "AUTHORIZED") throw new Error(`OAuth authorization did not complete for ${serverId}`);
    await provider.completeAuthorization();
    await this.disconnect(serverId);
    return this.checkHealth(serverId);
  }

  async disconnectOAuth(serverId: string): Promise<void> {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    const provider = this.getOAuthProvider(config);
    await provider.invalidateCredentials("tokens");
    await provider.invalidateCredentials("verifier");
    await provider.completeAuthorization();
    await this.disconnect(serverId);
  }

  private async createTransport(config: UpstreamServerConfig): Promise<{
    client: Client;
    transport: ProviderTransport | StreamableHTTPClientTransport;
    pid: number | null;
  }> {
    const client = new Client({ name: "bridge-dev-hub", version: "2.0.0" });

    if (config.transport === "stdio") {
      if(getPolicyGate().getActiveProfile()==="strict")throw new Error("STRICT_PROVIDER_REFUSED: stdio requires a separately reviewed OS sandbox; HTTP providers only");
      const transport = new ProviderTransport({
        command: config.command!,
        args: config.args,
        env: config.env,
        cwd: config.cwd,

      });
      await this.connectClient(client, transport, config.id);
      return { client, transport, pid: transport.pid };
    }

    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    const bearerEnv = config.bearer_token_env_var?.trim();
    if (bearerEnv) {
      const token = process.env[bearerEnv]?.trim();
      if (!token) throw new Error(`Missing bearer token environment variable for ${config.id}: ${bearerEnv}`);
      if (!headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${token}`;
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      authProvider: this.shouldUseOAuth(config) ? this.getOAuthProvider(config) : undefined,
      requestInit: Object.keys(headers).length ? { headers } : undefined,
      fetch: safeFetch(config.allow_private_network === true),
    });
    await this.connectClient(client, transport, config.id);
    return { client, transport, pid: null };
  }

  private async withConnectTimeout<T>(operation: Promise<T>, serverId: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Upstream connection timed out after ${this.connectTimeoutMs}ms: ${serverId}`)),
            this.connectTimeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async connectClient(
    client: Client,
    transport: ProviderTransport | StreamableHTTPClientTransport,
    serverId: string
  ): Promise<void> {
    try {
      await this.withConnectTimeout(client.connect(transport), serverId);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async connect(serverId: string, force = false): Promise<UpstreamConnection> {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    const failure=this.failures.get(serverId);
    if(failure && Date.now()<failure.until)throw new Error("PROVIDER_BACKOFF: "+failure.error);
    if (!config.enabled) throw new Error(`Upstream server disabled: ${serverId}`);

    const pending = this.connecting.get(serverId);
    if (pending) {
      const connection = await pending;
      if (!force) {
        this.touch(connection);
        return connection;
      }
    }

    const existing = this.connections.get(serverId);
    if (existing && existing.connected && !force) {
      this.touch(existing);
      return existing;
    }

    if (existing) await this.disconnect(serverId);

    const generation=this.generation;
    const attempt = (async (): Promise<UpstreamConnection> => {
      const { client, transport, pid } = await this.createTransport(config);
      try {
        const list = await this.withConnectTimeout(client.listTools(undefined,{timeout:15000}), serverId);
        const tools = validateToolMetadata(list.tools ?? []);
        if(generation!==this.generation || !this.getServerConfig(serverId)?.enabled)throw new Error("PROVIDER_DISABLED_DURING_CONNECT");
        const conn: UpstreamConnection = {
          config,
          client,
          transport,
          tools,
          lastUsedAt: Date.now(),
          idleTimer: null,
          connected: true,
          lastError: undefined,
        };
        if (config.transport === "stdio" && pid) {
          (conn as UpstreamConnection & { pid?: number }).pid = pid;
        }

        const oldClose=client.onclose;
        client.onclose=()=>{conn.connected=false;conn.lastError="PROVIDER_CONNECTION_CLOSED";oldClose?.();};
        this.failures.delete(serverId);
        this.connections.set(serverId, conn);
        this.toolsCache.set(serverId, { tools, expiresAt: Date.now() + this.toolsCacheTtlMs });
        this.touch(conn);
        return conn;
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
    })();
    this.connecting.set(serverId, attempt);
    try {
      return await attempt;
    } catch(error) {
      const count=(this.failures.get(serverId)?.count || 0)+1;
      this.failures.set(serverId,{count,until:Date.now()+Math.min(30000,250*2**Math.min(count,7)),error:String(error).slice(0,400)});
      throw error;
    } finally {
      if (this.connecting.get(serverId) === attempt) this.connecting.delete(serverId);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    conn.connected=false;
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    try {
      await conn.transport.close();
    } catch(error) {conn.lastError="PROVIDER_CLEANUP_FAILED";throw error;}
    this.connections.delete(serverId);
    this.toolsCache.delete(serverId);
  }

  async shutdown(): Promise<void> {
    this.generation++;
    await Promise.allSettled([...this.connecting.values()]);
    const results=await Promise.allSettled([...this.connections.keys()].map(id=>this.disconnect(id)));
    const errors=results.filter((result):result is PromiseRejectedResult=>result.status==="rejected").map(result=>result.reason);
    if(errors.length)throw new AggregateError(errors,"Provider cleanup failed; all remaining transports were still closed");
  }

  /** Pure read: never connect to an upstream or execute a stdio provider. */
  peekTools(serverId: string): Tool[] {
    const config = this.getServerConfig(serverId);
    if (!config || !config.enabled) return [];
    const conn = this.connections.get(serverId);
    return conn?.connected ? [...conn.tools] : [...(this.toolsCache.get(serverId)?.tools ?? [])];
  }

  /** Pure read for MCP R-class tools; live checks require X-class refresh. */
  listStatusesCached(): UpstreamServerStatus[] {
    return this.config.servers.map(config => {
      const conn = this.connections.get(config.id);
      const connected = Boolean(config.enabled && conn?.connected);
      return this.buildStatus(config, !config.enabled ? "disabled" : connected ? "connected" : "unknown",
        connected, connected ? conn!.tools : [], conn?.lastError || this.failures.get(config.id)?.error, connected ? conn : undefined);
    });
  }

  async listTools(serverId: string): Promise<Tool[]> {
    if(!this.getServerConfig(serverId)?.enabled)throw new Error("PROVIDER_DISABLED");
    const cached = this.toolsCache.get(serverId);
    if (cached && cached.expiresAt > Date.now()) return cached.tools;

    const conn = await this.connect(serverId);
    const list = await conn.client.listTools(undefined,{timeout:15000});
    const tools = validateToolMetadata(list.tools ?? []);
    conn.tools = tools;
    this.toolsCache.set(serverId, { tools, expiresAt: Date.now() + this.toolsCacheTtlMs });
    return tools;
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const config=this.getServerConfig(serverId);
    if(!config?.enabled || !this.getProxiedToolNames(config,[{name:toolName,inputSchema:{type:"object"}}]).length)throw new Error("PROVIDER_TOOL_DENIED");
    if(config.transport==="stdio"&&getPolicyGate().getActiveProfile()==="strict")throw new Error("STRICT_PROVIDER_REFUSED");
    const conn = await this.connect(serverId);
    const tool=conn.tools.find(item=>item.name===toolName);
    if(!tool)throw new Error("PROVIDER_UNKNOWN_TOOL");
    validateToolArguments(tool,args);
    this.touch(conn);
    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {timeout:15000});
      return sanitizeProviderResult(result,config.id);
    } catch(error){conn.lastError=String(error);await this.disconnect(serverId);throw error;}

  }

  providerLogs(serverId:string):{origin:string;last_error?:string;stderr_tail:string}{
    const config=this.getServerConfig(serverId);if(!config)throw new Error("PROVIDER_NOT_FOUND");
    const conn=this.connections.get(serverId),transport=conn?.transport;
    let stderr=transport instanceof ProviderTransport?transport.stderr:"";
    for(const value of [...Object.values(config.env||{}),process.env[config.bearer_token_env_var||""]||"",process.env.ADMIN_TOKEN||"",process.env.MCP_TOKEN||""])if(value.length>3)stderr=stderr.split(value).join("[REDACTED]");
    return {origin:"Untrusted provider "+serverId,last_error:conn?.lastError||this.failures.get(serverId)?.error,stderr_tail:stderr.slice(-8192)};
  }
  inspectCachedTools(serverId:string):Tool[]{return structuredClone(this.toolsCache.get(serverId)?.tools||[]);}
  async testProvider(serverId:string):Promise<{status:UpstreamServerStatus;tools:Tool[]}>{
    const config=this.getServerConfig(serverId);if(!config)throw new Error("PROVIDER_NOT_FOUND");
    const {client,transport}=await this.createTransport(config);
    try{
      const tools=validateToolMetadata((await this.withConnectTimeout(client.listTools(undefined,{timeout:15000}),serverId)).tools);
      this.toolsCache.set(serverId,{tools,expiresAt:Date.now()+this.toolsCacheTtlMs});
      return {status:this.buildStatus(config,"reachable",false,tools),tools};
    }finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});}
  }
  async checkHealth(serverId: string): Promise<UpstreamServerStatus> {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);

    if (!config.enabled) {
      return this.buildStatus(config, "disabled", false, []);
    }

    try {
      const conn = await this.connect(serverId);
      return this.buildStatus(config, "connected", true, conn.tools, undefined, conn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.buildStatus(config, "unreachable", false, [], message);
    }
  }

  async listStatuses(): Promise<UpstreamServerStatus[]> {
    return Promise.all(this.config.servers.map((config) => this.checkHealth(config.id)));
  }

  private buildStatus(
    config: UpstreamServerConfig,
    health: UpstreamHealth,
    connected: boolean,
    tools: Tool[],
    lastError?: string,
    conn?: UpstreamConnection
  ): UpstreamServerStatus {
    const proxied = this.getProxiedToolNames(config, tools);
    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      transport: config.transport,
      auth: config.transport !== "http" ? "none" : this.shouldUseOAuth(config) ? "oauth" : (Object.keys(config.headers ?? {}).length || config.bearer_token_env_var) ? "static" : "none",
      health,
      connected,
      tool_count: tools.length,
      expose: config.expose,
      proxied_tools: proxied,
      last_error: lastError,
      pid: conn && "pid" in conn ? (conn as UpstreamConnection & { pid?: number }).pid ?? null : null,
    };
  }

  getProxiedToolNames(config: UpstreamServerConfig, tools: Tool[]): string[] {
    if (!config.enabled || config.expose === "none" || config.expose === "meta_only") return [];

    return tools
      .filter((tool) => !(config.disabled_tools ?? []).includes(tool.name))
      .filter((tool) => config.expose === "all" || (config.tools ?? []).includes(tool.name))
      .map((tool) => proxyToolName(config.tool_prefix ?? config.id,tool.name));
  }

  async refreshAllProxies(): Promise<void> {
    const { refreshProxiedTools } = await import("./mcp-tool-proxy.js");
    for (const server of this.servers) {
      await refreshProxiedTools(server, this);
      server.sendToolListChanged();
    }
  }
}

export function getUpstreamManager(): McpUpstreamManager {
  if (!singleton) {
    singleton = new McpUpstreamManager();
  }
  return singleton;
}

export async function initUpstreamManager(): Promise<McpUpstreamManager> {
  const manager = getUpstreamManager();
  await manager.init();
  return manager;
}
