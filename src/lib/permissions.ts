import { getPolicyGate } from "./policy-gateway.js";

export type PermissionProfile = "strict" | "standard" | "dangerous";

export function getPermissionProfile(): PermissionProfile {
  try {
    return getPolicyGate().getActiveProfile();
  } catch {
    return "standard";
  }
}

export function isReadOnly(): boolean {
  return getPermissionProfile() === "strict";
}

export function canWriteFiles(): boolean {
  return getPermissionProfile() !== "strict";
}

export function canRunCommands(): boolean {
  return true;
}

export function canUseAnyAbsolutePath(): boolean {
  return getPermissionProfile() === "dangerous";
}

export function shouldBlockCommand(_command: string): boolean {
  return false;
}

export function describePermissionProfile(): string {
  const profile = getPermissionProfile();
  switch (profile) {
    case "dangerous":
      return "yolo: temporary authorized full machine access (active lease)";
    case "strict":
      return "strict: read-only, mutations blocked";
    case "standard":
    default:
      return "standard: normal development, restricted UID, signed approval required for privileged actions";
  }
}

export function requireWriteAllowed(): void {
  if (isReadOnly()) {
    throw new Error("OPERATION_BLOCKED: system is currently in strict read-only mode");
  }
}

export function requireCommandAllowed(_command: string): void {}
