import { getPolicyGate } from "./policy-gateway.js";
import { canonicalPath, isSecretPath } from "./policy-paths.js";

/** Also applied inside recursive scanner implementations, before opening any candidate file. */
export function mayReadScannedPath(candidate: string): boolean {
  try {
    const policy = getPolicyGate().config;
    return !isSecretPath(canonicalPath(candidate),policy);
  } catch {
    return false;
  }
}
