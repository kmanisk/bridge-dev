import {AsyncLocalStorage} from "node:async_hooks";
// Internal decision binding; never writable by MCP input.
export const executionAuthority=new AsyncLocalStorage<{hostRoot:boolean;approvalId?:string}>();
