import { AsyncLocalStorage } from "node:async_hooks";

// Populated only after HTTP authentication, never from tool arguments/clientInfo.
export const requestIdentity = new AsyncLocalStorage<{ subject: string }>();
