import {createHash} from "node:crypto";
import type {Tool} from "@modelcontextprotocol/sdk/types.js";
import {CallToolResultSchema} from "@modelcontextprotocol/sdk/types.js";
import {AjvJsonSchemaValidator} from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import {z} from "zod";
export function cleanProviderText(text:string,max=2000):string{return text.replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,"").slice(0,max);}
export function proxyToolName(provider:string,tool:string):string{
  const raw=provider+"__"+tool;
  const safe=raw.replace(/[^a-zA-Z0-9_-]/g,"_");
  if(safe.length<=64 && raw===safe)return safe;
  return safe.slice(0,51)+"_"+createHash("sha256").update(raw).digest("hex").slice(0,12);
}
function checkSchema(schema:unknown,depth=0):void{
  if(depth>16)throw new Error("PROVIDER_SCHEMA_DEPTH_LIMIT");
  if(schema && typeof schema==="object")for(const [key,value]of Object.entries(schema)){
    // Refuse remote references and regex execution from untrusted schemas.
    if(["$ref","$dynamicRef","pattern","patternProperties","__proto__","constructor","prototype"].includes(key))throw new Error("PROVIDER_SCHEMA_UNSUPPORTED: "+key);
    checkSchema(value,depth+1);
  }
}
export function validateToolMetadata(tools:Tool[]):Tool[]{
  if(tools.length>256)throw new Error("PROVIDER_TOOL_COUNT_LIMIT");
  const names=new Set<string>();
  for(const tool of tools){
    if(typeof tool.name!=="string" || !tool.name.length || tool.name.length>256 || names.has(tool.name))throw new Error("PROVIDER_INVALID_TOOL_NAME");
    names.add(tool.name);
    if(Buffer.byteLength(JSON.stringify(tool))>65536)throw new Error("PROVIDER_METADATA_SIZE_LIMIT");
    checkSchema(tool.inputSchema);if(tool.outputSchema)checkSchema(tool.outputSchema);
    new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
    if(tool.outputSchema)new AjvJsonSchemaValidator().getValidator(tool.outputSchema);
  }
  return tools;
}
/** Keep the original JSON Schema, without a lossy JSON Schema -> Zod shape conversion. */
export function providerOutputSchema(schema:NonNullable<Tool["outputSchema"]>):z.ZodObject {
  checkSchema(schema);
  const validate=new AjvJsonSchemaValidator().getValidator(schema);
  return z.looseObject({}).superRefine((value,ctx)=>{
    const result=validate(value);
    if(!result.valid)ctx.addIssue({code:"custom",message:"PROVIDER_INVALID_OUTPUT: "+result.errorMessage});
  }).meta({...schema});
}
export function validateToolArguments(tool:Tool,args:unknown):void{
  if(Buffer.byteLength(JSON.stringify(args))>1048576)throw new Error("PROVIDER_ARGUMENT_SIZE_LIMIT");
  const result=new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args);
  if(!result.valid)throw new Error("PROVIDER_INVALID_ARGUMENTS: "+result.errorMessage);
}
export function sanitizeProviderResult(result:unknown,origin:string,tool?:Tool):unknown{
  if(Buffer.byteLength(JSON.stringify(result))>4*1024*1024)throw new Error("PROVIDER_RESPONSE_SIZE_LIMIT");
  const parsed=CallToolResultSchema.parse(result);
  if(tool?.outputSchema && (!parsed.isError || parsed.structuredContent!==undefined)){
    if(parsed.structuredContent===undefined)throw new Error("PROVIDER_INVALID_OUTPUT: missing structuredContent");
    const checked=new AjvJsonSchemaValidator().getValidator(tool.outputSchema)(parsed.structuredContent);
    if(!checked.valid)throw new Error("PROVIDER_INVALID_OUTPUT: "+checked.errorMessage);
  }
  for(const item of parsed.content)if(item.type==="text")item.text=cleanProviderText(item.text,1048576);
  parsed.content.unshift({type:"text",text:"[Untrusted result from provider: "+origin+"]"});
  return parsed;
}
