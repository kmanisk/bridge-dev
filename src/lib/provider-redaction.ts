import type {UpstreamServerConfig} from "./mcp-upstream-config.js";
import {redactAudit} from "./hash-audit.js";
/** All granted values may be secrets, regardless of their variable/header names. */
export function publicProvider(config:UpstreamServerConfig):unknown{
 const {env,headers,...rest}=config;
 return redactAudit({...rest,env:Object.fromEntries(Object.keys(env||{}).map(key=>[key,"[REDACTED]"])),headers:Object.fromEntries(Object.keys(headers||{}).map(key=>[key,"[REDACTED]"]))});
}
