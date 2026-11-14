/** Permission diagnostics must identify the requested item, never private paths. */
export function isReadPermissionError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    ["EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code)));
}
export function readPermissionError(kind: "skill" | "file" | "document", label: string): Error {
  const safe = label.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128);
  const error = new Error(`${kind.toUpperCase()}_PERMISSION_DENIED: permission denied for ${kind} ${safe}`);
  (error as NodeJS.ErrnoException).code = "EACCES";
  return error;
}
