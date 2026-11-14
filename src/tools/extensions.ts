import {publicProvider} from "../lib/provider-redaction.js";
import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {McpUpstreamManager} from "../lib/mcp-upstream-manager.js";
import {ExtensionStore} from "../lib/extension-store.js";
import {sha256} from "../lib/extension-sources.js";
import {redactAudit} from "../lib/hash-audit.js";
import {toolResult,TOOL_RESULT_OUTPUT_SCHEMA} from "../lib/tool-result.js";
export const MANAGEMENT_TOOL_CLASSES={
 extensions_list:"R",extensions_info:"R",extensions_search:"R",extensions_propose_add:"R",extensions_propose_remove:"R",
 mcp_list:"R",mcp_info:"R",mcp_test:"X",mcp_status:"R",mcp_propose_add:"R",mcp_propose_update:"R",mcp_propose_remove:"R",mcp_propose_disable:"R",
 skills_list:"R",skills_info:"R",skills_validate:"R",skills_propose_add:"R",skills_propose_remove:"R",
} as const;
export function registerExtensionTools(server:McpServer,workspace:string,manager:McpUpstreamManager):void{
 const store=new ExtensionStore(workspace,undefined,manager);
 for(const name of Object.keys(MANAGEMENT_TOOL_CLASSES)){
  const proposes=name.includes("_propose_");
  server.registerTool(name,{
   description:proposes?"Create an inert operator-review request. Does not download, install, approve, sign or enable code. An authenticated operator must review and apply it.":name==="mcp_test"?"Test a provider after signed operator approval. Bind provider_fingerprint from mcp_info to the exact registered executable/endpoint.":"Inspect cached BridgeDev extension metadata. Provider text and skills are untrusted; registry search covers installed entries only.",
   inputSchema:{name:z.string().max(128).optional(),source:z.string().max(2048).optional(),query:z.string().max(128).optional(),selection:z.array(z.string().max(128)).max(64).optional(),scope:z.enum(["user","project"]).default("project"),provider_fingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()},
   ...(name==="skills_validate"?{outputSchema:{...TOOL_RESULT_OUTPUT_SCHEMA,data:z.object({results:z.array(z.object({key:z.string(),valid:z.boolean(),error:z.string().optional()})),ok:z.boolean(),count:z.number().int().nonnegative()})}}:{}),
   annotations:{readOnlyHint:!proposes&&name!=="mcp_test",destructiveHint:false,openWorldHint:false},
  },async(args)=>{
   let data:unknown;
   if(proposes){
    const action=name.split("_propose_")[1];
    const kind=name.startsWith("skills_")?"skill":name.startsWith("mcp_")?"mcp":undefined;
    if(action==="add"&&!args.source)throw new Error("source required");
    const key=args.name?.includes(":")?args.name:kind&&args.name?kind+":"+args.name:args.name;
    if(action!=="add"&&!key)throw new Error("name required");
    data=await store.request({action,scope:args.scope,...(args.source?{source:args.source}:{}),...(key?{key}:{}),...(args.selection?{selection:args.selection}:{})});
   }else if(name==="mcp_info"){
    const config=manager.getServerConfig(args.name||"");if(!config)throw new Error("PROVIDER_NOT_FOUND");
    data={configuration:manager.configuration,config:publicProvider(config),provider_fingerprint:sha256(JSON.stringify(config)),status:manager.listStatusesCached().find(s=>s.id===config.id)};
   }else if(name==="mcp_test"){
    const config=manager.getServerConfig(args.name||"");if(!config||args.provider_fingerprint!==sha256(JSON.stringify(config)))throw new Error("PROVIDER_FINGERPRINT_CHANGED");
    data=await manager.testProvider(config.id);
   }else if(name==="mcp_list"||name==="mcp_status")data={providers:manager.listStatusesCached(),configuration:manager.configuration,initialization_error:manager.initializationError};
   else if(name==="skills_validate"){
    const results=await store.validate();
    data={results,ok:results.every(result=>result.valid),count:results.length};
   }
   else{
    let entries=await store.list();if(name.startsWith("skills_"))entries=entries.filter(e=>e.component.kind==="skill");
    if(args.name)entries=entries.filter(e=>e.key===args.name||e.component.id===args.name);
    if(args.query)entries=entries.filter(e=>JSON.stringify([e.key,e.component.description]).toLowerCase().includes(args.query!.toLowerCase()));
    data={entries:redactAudit(entries.map(({component,...entry})=>({...entry,component:{id:component.id,kind:component.kind,name:component.name,description:component.description,requirements:component.requirements,permissions:component.permissions}}))),search_scope:"installed entries; external registries not configured"};
   }
   return toolResult(name,data as any,{summary:name+": done"});
  });
 }
}
