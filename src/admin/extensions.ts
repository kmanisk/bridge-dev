import path from "node:path";
import {atomicJson} from "../lib/atomic-store.js";
import {portableStateDir,getRuntimeMode} from "../lib/runtime.js";
import {Router} from "express";
import {z} from "zod";
import {ExtensionStore} from "../lib/extension-store.js";
import type {McpUpstreamManager} from "../lib/mcp-upstream-manager.js";
import {getPolicyGate} from "../lib/policy-gateway.js";
import {redactAudit} from "../lib/hash-audit.js";
import {sha256} from "../lib/extension-sources.js";
export function extensionRouter(manager:McpUpstreamManager):Router{
 const router=Router(),store=new ExtensionStore(undefined,undefined,manager);
 const scope=z.enum(["user","project"]).default("project");
 const run=(handler:(req:any)=>Promise<unknown>)=>async(req:any,res:any)=>{try{res.json({ok:true,data:redactAudit(await handler(req))});}catch(error){res.status(400).json({ok:false,error:String(redactAudit(String(error)))});}};
 router.post("/api/mode",run(async req=>{
  if(getRuntimeMode()!=="portable")throw new Error("Managed modes require the independent signed operator CLI");
  const {mode}=z.object({mode:z.enum(["strict","standard"])}).strict().parse(req.body);
  await getPolicyGate().audit.append({phase:"operator_portable_mode",mode});await atomicJson(path.join(portableStateDir(),"mode.json"),{mode});await manager.shutdown();await manager.refreshAllProxies();return {mode};
 }));
 router.get("/api/extensions",run(async()=>({entries:await store.list(),requests:await store.requests(),providers:manager.listStatusesCached(),registry_error:manager.initializationError})));
 router.post("/api/extensions/discover",run(async req=>{const body=z.object({source:z.string().min(1).max(2048),selection:z.array(z.string()).max(64).optional(),scope}).strict().parse(req.body);return store.propose(body.source,body.selection,body.scope);}));
 router.get("/api/extensions/proposal/:id",run(req=>store.proposal(req.params.id)));
 router.post("/api/extensions/review",run(req=>store.reviewRequest(z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).parse(req.body).id)));
 router.post("/api/extensions/action",run(req=>{const body=z.object({action:z.enum(["remove","update","enable","disable"]),key:z.string().min(1).max(128),scope}).strict().parse(req.body);return store.proposeAction(body.action,body.key,body.scope);}));
 router.post("/api/extensions/provider-review",run(req=>{const body=z.object({name:z.string(),enabled:z.boolean(),tools:z.array(z.string().max(256)).max(256).default([]),permission:z.enum(["R","W","X"]).default("X"),allow_private_network:z.boolean().default(false)}).strict().parse(req.body);return store.proposeProvider(body.name,{enabled:body.enabled,expose:"allowlist",tools:body.tools,tool_permissions:Object.fromEntries(body.tools.map(name=>[name,body.permission])),allow_private_network:body.allow_private_network});}));
 router.post("/api/extensions/provider-test",run(async req=>{const {name}=z.object({name:z.string()}).strict().parse(req.body),config=manager.getServerConfig(name);if(!config)throw new Error("PROVIDER_NOT_FOUND");await getPolicyGate().audit.append({phase:"operator_provider_test",provider:name,fingerprint:sha256(JSON.stringify(config))});return manager.testProvider(name);}));
 router.get("/api/extensions/provider-logs",run(async req=>manager.providerLogs(String(req.query.name||""))));
 router.get("/api/extensions/provider-tools",run(async req=>({origin:"untrusted provider",tools:manager.inspectCachedTools(String(req.query.name||""))})));
 router.post("/api/extensions/apply",run(async req=>{
  const {id}=z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
  const proposal=await store.proposal(id);
  await getPolicyGate().audit.append({phase:"operator_extension_approval",id,action:proposal.action,source:proposal.discovery?.source,resolved:proposal.discovery?.resolved,digest:proposal.discovery?.digest});
  try{const result=await store.apply(id);await manager.refreshAllProxies();
   await getPolicyGate().audit.append({phase:"operator_extension_result",id,status:"ok"});return result;
  }catch(error){await getPolicyGate().audit.append({phase:"operator_extension_result",id,status:"error",error:String(error)});throw error;}
 }));
 return router;
}
