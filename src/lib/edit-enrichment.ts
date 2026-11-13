import { runPostEditHooks } from "./post-edit-hooks.js";
import { documentationPlanForPaths } from "./docs-routing.js";

export async function enrichAfterEdit<T extends Record<string, unknown>>(
  data: T,
  filePaths: string[],
  dryRun?: boolean
): Promise<T> {
  if (dryRun || !filePaths.length) return data;
  const [hooks, documentation] = await Promise.all([
    runPostEditHooks(filePaths),
    Promise.resolve(documentationPlanForPaths(filePaths)),
  ]);
  return { ...data, ...(hooks || {}), ...(documentation ? { documentation } : {}) };
}