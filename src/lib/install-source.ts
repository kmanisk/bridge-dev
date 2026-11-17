import fs from "node:fs";
import path from "node:path";
import { sourceRoot } from "./service-config.js";

export type InstallSource = "managed" | "npm" | "portable-installer" | "source";

/** Classify the invoked executable's own package root, not the cwd or a
 * different BridgeDev service on the machine. This is deliberately read-only. */
export function detectInstallSource(root: string = sourceRoot): InstallSource {
  const dir = path.resolve(root);
  try {
    if (/^[a-f0-9]{40}\s*$/.test(fs.readFileSync(path.join(dir, "DEPLOYED_COMMIT"), "utf8"))) {
      return "managed";
    }
  } catch {}
  const parent = path.dirname(dir);
  if (path.basename(dir) === "bridge-dev" && path.basename(parent) === "node_modules") {
    return "npm";
  }
  if (path.basename(dir) === "bridge-dev" &&
      path.basename(parent) !== "node_modules" &&
      path.basename(path.dirname(parent)) === "node_modules" &&
      path.basename(parent).startsWith("@")) {
    return "npm";
  }
  // The user-scoped GitHub installer builds into <data-root>/app.
  if (path.basename(dir) === "app" &&
      fs.existsSync(path.join(dir, "scripts", "install-portable.mjs"))) {
    return "portable-installer";
  }
  return "source";
}

export function updateInstructions(source: InstallSource, packageName = "bridge-dev"): string {
  if (source === "npm") {
    return `npm install -g ${packageName}@latest (run as your normal user; restart an existing foreground process separately)`;
  }
  if (source === "portable-installer") {
    return "re-run the reviewed install.sh / install.ps1; stop an existing foreground gateway first";
  }
  return "bridge-dev update (verified GitHub release; local operator only)";
}
