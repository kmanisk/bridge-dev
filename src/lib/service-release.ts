import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { atomicJson, withFileLock } from "./atomic-store.js";
import { safeRelative } from "./extension-sources.js";
import { extractZip } from "./safe-zip.js";
import {
  operatorEnvironment,
  shaPattern,
  sourceRoot,
} from "./service-config.js";
const exec = promisify(execFile),
  hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const file = z
  .object({
    path: z.string(),
    mode: z.union([z.literal(0o444), z.literal(0o555)]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    data: z.string().optional(),
    link: z.string().optional(),
  })
  .strict();
const bundle = z
  .object({
    version: z.literal(1),
    commit: z.string().regex(shaPattern),
    files: z.array(file).min(1).max(15000),
  })
  .strict();
type ReleaseBundle = z.infer<typeof bundle>;
export interface ReleaseManifest {
  version: 1;
  commit: string;
  files: Omit<ReleaseBundle["files"][number], "data">[];
  evidence: Record<string, unknown>;
}
const MANIFEST = "RELEASE_MANIFEST.json";
export async function createReleaseBundle(
  root: string,
  commit: string,
): Promise<Buffer> {
  if (!shaPattern.test(commit)) throw Error("RELEASE_COMMIT_REQUIRED");
  const files: ReleaseBundle["files"] = [];
  async function visit(dir: string) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const full = path.join(dir, name),
        rel = path.relative(root, full).split(path.sep).join("/"),
        st = await fs.lstat(full);
      if (st.isSymbolicLink()) {
        const link = await fs.readlink(full),
          resolved = path.resolve(path.dirname(full), link);
        if (
          path.isAbsolute(link) ||
          !resolved.startsWith(path.resolve(root) + path.sep)
        )
          throw Error("RELEASE_LINK_ESCAPE");
        files.push({ path: rel, mode: 0o444, link, sha256: hash(link) });
      } else if (st.isDirectory()) await visit(full);
      else if (st.isFile()) {
        if (st.size > 64 * 1048576) throw Error("RELEASE_FILE_TOO_LARGE");
        const data = await fs.readFile(full);
        files.push({
          path: rel,
          mode: st.mode & 0o111 ? 0o555 : 0o444,
          sha256: hash(data),
          data: data.toString("base64"),
        });
      } else throw Error("RELEASE_SPECIAL_FILE_REFUSED");
    }
  }
  for (const name of [
    "dist",
    "public",
    "profiles",
    "scripts",
    "src",
    "docs",
    "node_modules",
  ])
    if (sync.existsSync(path.join(root, name)))
      await visit(path.join(root, name));
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "LICENSE",
    "README.md",
  ]) {
    const b = await fs.readFile(path.join(root, name));
    files.push({
      path: name,
      mode: 0o444,
      sha256: hash(b),
      data: b.toString("base64"),
    });
  }
  const marker = Buffer.from(commit + "\n");
  files.push({
    path: "DEPLOYED_COMMIT",
    mode: 0o444,
    sha256: hash(marker),
    data: marker.toString("base64"),
  });
  const data = Buffer.from(
    JSON.stringify(bundle.parse({ version: 1, commit, files })),
  );
  if (data.length > 256 * 1048576) throw Error("RELEASE_BUNDLE_SIZE_LIMIT");
  return gzipSync(data);
}
export async function verifyRelease(
  root: string,
  expectedCommit?: string,
): Promise<ReleaseManifest> {
  const metadata = JSON.parse(
    await fs.readFile(path.join(root, MANIFEST), "utf8"),
  ) as ReleaseManifest;
  if (
    metadata.version !== 1 ||
    !shaPattern.test(metadata.commit) ||
    (expectedCommit && metadata.commit !== expectedCommit) ||
    !Array.isArray(metadata.files) ||
    metadata.files.length > 15000
  )
    throw Error("RELEASE_MANIFEST_INVALID_OR_FUTURE");
  const seen = new Set<string>();
  let total = 0;
  for (const raw of metadata.files) {
    const entry = file.omit({ data: true }).parse(raw);
    safeRelative(entry.path);
    if (seen.has(entry.path)) throw Error("RELEASE_DUPLICATE");
    seen.add(entry.path);
    const target = path.join(root, entry.path),
      st = await fs.lstat(target);
    if (entry.link !== undefined) {
      if (
        !st.isSymbolicLink() ||
        (await fs.readlink(target)) !== entry.link ||
        hash(entry.link) !== entry.sha256
      )
        throw Error("RELEASE_LINK_CHANGED");
      const real = await fs.realpath(target);
      if (!real.startsWith(path.resolve(root) + path.sep))
        throw Error("RELEASE_LINK_ESCAPE");
    } else {
      if ((st.mode & 0o777) !== entry.mode)
        throw Error("RELEASE_MODE_CHANGED: " + entry.path);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.size > 64 * 1048576 ||
        (total += st.size) > 256 * 1048576 ||
        hash(await fs.readFile(target)) !== entry.sha256
      )
        throw Error("RELEASE_FILE_CHANGED: " + entry.path);
    }
  }
  async function checkNames(directory: string): Promise<void> {
    for (const name of await fs.readdir(directory)) {
      const full = path.join(directory, name),
        relative = path.relative(root, full).split(path.sep).join("/"),
        stat = await fs.lstat(full);
      if (stat.isDirectory()) {
        if (stat.mode & 0o022) throw Error("RELEASE_WRITABLE_DIRECTORY");
        await checkNames(full);
      } else if (relative !== MANIFEST && !seen.has(relative))
        throw Error("RELEASE_UNMANIFESTED_FILE");
    }
  }
  await checkNames(root);
  if (
    (await fs.readFile(path.join(root, "DEPLOYED_COMMIT"), "utf8")).trim() !==
      metadata.commit ||
    !seen.has("dist/index.js") ||
    !seen.has("dist/cli.js") ||
    !seen.has("package.json")
  )
    throw Error("RELEASE_ENTRYPOINT_OR_MARKER_INVALID");
  return metadata;
}
export async function stageBundle(
  bytes: Buffer,
  installRoot: string,
  commit: string,
  evidence: Record<string, unknown>,
): Promise<string> {
  if (bytes.length > 64 * 1048576) throw Error("RELEASE_DOWNLOAD_LIMIT");
  const value = bundle.parse(
    JSON.parse(
      gunzipSync(bytes, { maxOutputLength: 256 * 1048576 }).toString("utf8"),
    ),
  );
  if (value.commit !== commit) throw Error("RELEASE_COMMIT_MISMATCH");
  const base = path.join(installRoot, "releases"),
    target = path.join(base, commit);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  return withFileLock(target, async () => {
    if (sync.existsSync(target)) {
      await verifyRelease(target, commit);
      return target;
    }
    const staged = path.join(base, ".stage-" + randomUUID());
    await fs.mkdir(staged, { mode: 0o700 });
    const names = new Set<string>();
    let total = 0;
    try {
      for (const entry of value.files) {
        safeRelative(entry.path);
        if (entry.path === MANIFEST || names.has(entry.path))
          throw Error("RELEASE_DUPLICATE_OR_RESERVED");
        names.add(entry.path);
      }
      for (const entry of value.files)
        if (entry.link !== undefined) {
          if (
            entry.data !== undefined ||
            path.isAbsolute(entry.link) ||
            /[\x00-\x1f]/.test(entry.link) ||
            !path
              .resolve(path.dirname(path.join(staged, entry.path)), entry.link)
              .startsWith(staged + path.sep) ||
            [...names].some((n) => n.startsWith(entry.path + "/"))
          )
            throw Error("RELEASE_LINK_ESCAPE_OR_PARENT");
        }
      for (const entry of value.files) {
        const full = path.join(staged, entry.path);
        await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o755 });
        if (entry.link !== undefined) {
          if (hash(entry.link) !== entry.sha256)
            throw Error("RELEASE_LINK_INTEGRITY");
          continue;
        }
        if (
          typeof entry.data !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data) ||
          entry.data.length > 88 * 1048576
        )
          throw Error("RELEASE_FILE_ENCODING");
        const data = Buffer.from(entry.data, "base64");
        if (
          data.length > 64 * 1048576 ||
          (total += data.length) > 256 * 1048576 ||
          hash(data) !== entry.sha256
        )
          throw Error("RELEASE_INTEGRITY");
        await fs.writeFile(full, data, { flag: "wx", mode: entry.mode });
        await fs.chmod(full, entry.mode);
      }
      for (const entry of value.files)
        if (entry.link !== undefined)
          await fs.symlink(entry.link, path.join(staged, entry.path));
      await atomicJson(path.join(staged, MANIFEST), {
        version: 1,
        commit,
        files: value.files.map(({ data, ...rest }) => rest),
        evidence,
      });
      await verifyRelease(staged, commit);
      // The root must stay owner-writable for cross-parent installation/rollback.
      await fs.chmod(staged, 0o755);
      await fs.rename(staged, target);
      return target;
    } catch (error) {
      await fs.rm(staged, { recursive: true, force: true });
      throw error;
    }
  });
}
export function verifyCiEvidence(runs: any[], commit: string): void {
  for (const name of [
    "policy-tests",
    "portable-platforms",
    "linux-distributions",
  ]) {
    const found = runs
      .filter(
        (r) =>
          r.name === name &&
          r.head_sha === commit &&
          r.head_branch === "main" &&
          r.event === "push",
      )
      .sort((a, b) => b.id - a.id)[0];
    if (
      !found ||
      found.status !== "completed" ||
      found.conclusion !== "success"
    )
      throw Error("SERVICE_CI_NOT_GREEN: " + name);
  }
}
/** Preserve the actual category of an operator-account GitHub failure.
 * Never echo stderr, OAuth tokens, URLs, or auth headers into CLI logs. */
export function githubAccessError(error: unknown): Error {
  const e = error as {code?:unknown;stderr?:unknown;message?:unknown};
  const stderr = String(e?.stderr || "");
  const code = String(e?.code || "");
  if (code === "ENOENT") return Error("SERVICE_GH_BINARY_MISSING: gh is not installed on this operator PATH");
  if (/HTTP (?:401|403)|authentication required|not logged (?:in|into)|Bad credentials|authorization failed/i.test(stderr))
    return Error("SERVICE_GITHUB_AUTH_DENIED: operator gh session lacks GitHub API access");
  if (/HTTP 429|rate limit exceeded|secondary rate limit/i.test(stderr))
    return Error("SERVICE_GITHUB_RATE_LIMITED: retry only after checking the existing update job");
  if (/Could not resolve host|Temporary failure in name resolution|Network is unreachable|Failed to connect|Connection timed out/i.test(stderr))
    return Error("SERVICE_GITHUB_NETWORK_FAILED: GitHub could not be reached");
  if (/HTTP 404|Not Found/i.test(stderr))
    return Error("SERVICE_GITHUB_NOT_FOUND: requested release metadata is unavailable");
  if (code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return Error("SERVICE_GITHUB_TRANSPORT_FAILED: " + code);
  return Error("SERVICE_GITHUB_QUERY_FAILED: gh api exit " +
    (/^\\d+$/.test(code) ? code : "unknown") + "; inspect the isolated operator command, not the production gateway");
}
async function github(route: string, binary = false): Promise<any> {
  // gh supplies its protected credential itself; never inline a token or log it.
  try {
    const r = await exec("gh", ["api", "repos/kmanisk/bridge-dev/" + route], {
      env: operatorEnvironment(),
      encoding: binary ? "buffer" : "utf8",
      timeout: 60000,
      maxBuffer: 64 * 1048576,
    });
    return binary ? r.stdout : JSON.parse(String(r.stdout));
  } catch (error) {
    throw githubAccessError(error);
  }
}
/** A staged release can be reused by the local CLI and the transient job.
 * The exact SHA, immutable file digests and GitHub CI evidence must all match.
 * Existing but invalid candidate directories fail closed instead of refetching. */
export async function verifiedStagedRelease(
  ref:string,root:string
):Promise<{commit:string;release:string}|null>{
  if(!/^[a-f0-9]{40}$/.test(ref))return null;
  const candidate=path.join(root,"releases",ref);
  if(!sync.existsSync(candidate))return null;
  const manifest=await verifyRelease(candidate,ref);
  if(manifest.evidence?.verified_ci!==true ||
     manifest.evidence?.repository!=="kmanisk/bridge-dev" ||
     !Number.isSafeInteger(manifest.evidence?.workflow_run) ||
     !/^sha256:[a-f0-9]{64}$/.test(String(manifest.evidence?.artifact_digest)))
    throw Error("SERVICE_STAGED_PROVENANCE_INVALID");
  return {commit:ref,release:candidate};
}
export async function stageVerifiedGithubRelease(
  ref: string,
  root: string,
): Promise<{ commit: string; release: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref) || ref.includes(".."))
    throw Error("SERVICE_RELEASE_REF_INVALID");
  const metadata = await github("commits/" + encodeURIComponent(ref)),
    commit = metadata.sha;
  if (!shaPattern.test(commit)) throw Error("SERVICE_RELEASE_COMMIT_INVALID");
  const runs = await github("actions/runs?head_sha=" + commit + "&per_page=50");
  verifyCiEvidence(runs.workflow_runs || [], commit);
  const producing = (runs.workflow_runs || []).find(
    (r: any) =>
      r.name === "portable-platforms" &&
      r.head_branch === "main" &&
      r.event === "push" &&
      r.head_sha === commit &&
      r.status === "completed" &&
      r.conclusion === "success",
  );
  const artifacts = await github(
      "actions/runs/" + producing.id + "/artifacts?per_page=100",
    ),
    artifact = artifacts.artifacts?.find(
      (a: any) =>
        a.name === "bridge-dev-node-" + commit &&
        !a.expired &&
        a.workflow_run?.head_sha === commit,
    );
  if (
    !artifact ||
    !Number.isSafeInteger(artifact.id) ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
    artifact.size_in_bytes > 64 * 1048576
  )
    throw Error("SERVICE_CI_ARTIFACT_MISSING_OR_UNVERIFIABLE");
  const zip = (await github(
    "actions/artifacts/" + artifact.id + "/zip",
    true,
  )) as Buffer;
  if ("sha256:" + hash(zip) !== artifact.digest)
    throw Error("SERVICE_CI_ARTIFACT_DIGEST_MISMATCH");
  const files = extractZip(zip, {
      maxArchive: 64 * 1048576,
      maxFile: 64 * 1048576,
      maxTotal: 64 * 1048576,
      maxFiles: 8,
    }),
    names = Object.keys(files);
  if (names.length !== 1 || names[0] !== "bridge-dev.release.json.gz")
    throw Error("SERVICE_CI_ARTIFACT_CONTENT_INVALID");
  const release = await stageBundle(files[names[0]], root, commit, {
    repository: "kmanisk/bridge-dev",
    workflow_run: producing.id,
    artifact_id: artifact.id,
    artifact_digest: artifact.digest,
    verified_ci: true,
  });
  return { commit, release };
}
export async function seedLocalRelease(
  root: string,
  source = sourceRoot,
): Promise<{ commit: string; release: string }> {
  let commit: string;
  try {
    commit = (
      await fs.readFile(path.join(source, "DEPLOYED_COMMIT"), "utf8")
    ).trim();
  } catch {
    try {
      commit = (
        await exec("git", ["-C", source, "rev-parse", "HEAD"], {
          env: operatorEnvironment(),
          timeout: 3000,
          encoding: "utf8",
        })
      ).stdout.trim();
    } catch {
      throw Error(
        "SERVICE_SOURCE_COMMIT_REQUIRED: build a Git checkout or supply a marked release",
      );
    }
  }
  if (!shaPattern.test(commit)) throw Error("SERVICE_SOURCE_COMMIT_INVALID");
  if (!sync.existsSync(path.join(source, "DEPLOYED_COMMIT"))) {
    const changed = await exec("git", ["-C", source, "status", "--porcelain"], {
      env: operatorEnvironment(),
      timeout: 3000,
      encoding: "utf8",
    });
    if (changed.stdout.trim())
      throw Error(
        "SERVICE_SOURCE_DIRTY: install a verified release or a clean built checkout",
      );
  }
  const base = path.join(root, "releases"),
    release = path.join(base, commit);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  return withFileLock(release, async () => {
    if (sync.existsSync(release)) {
      await verifyRelease(release, commit);
      return { commit, release };
    }
    const temp = path.join(base, ".seed-" + randomUUID());
    await fs.mkdir(temp, { mode: 0o755 });
    const files: ReleaseManifest["files"] = [];
    async function copy(from: string, to: string): Promise<void> {
      const st = await fs.lstat(from),
        relative = path.relative(temp, to).split(path.sep).join("/");
      if (st.isDirectory()) {
        await fs.mkdir(to, { mode: 0o755 });
        for (const name of (await fs.readdir(from)).sort())
          await copy(path.join(from, name), path.join(to, name));
      } else if (st.isSymbolicLink()) {
        const link = await fs.readlink(from);
        if (
          path.isAbsolute(link) ||
          !path.resolve(path.dirname(to), link).startsWith(temp + path.sep)
        )
          throw Error("RELEASE_LINK_ESCAPE");
        await fs.symlink(link, to);
        files.push({ path: relative, mode: 0o444, link, sha256: hash(link) });
      } else if (st.isFile()) {
        if (st.size > 64 * 1048576) throw Error("RELEASE_FILE_TOO_LARGE");
        await fs.copyFile(from, to);
        const mode = st.mode & 0o111 ? 0o555 : 0o444;
        await fs.chmod(to, mode);
        files.push({
          path: relative,
          mode,
          sha256: hash(await fs.readFile(to)),
        });
      } else throw Error("RELEASE_SPECIAL_FILE_REFUSED");
    }
    try {
      for (const name of [
        "dist",
        "public",
        "profiles",
        "scripts",
        "src",
        "docs",
        "node_modules",
        "package.json",
        "pnpm-lock.yaml",
        "LICENSE",
        "README.md",
      ])
        if (sync.existsSync(path.join(source, name)))
          await copy(path.join(source, name), path.join(temp, name));
      const marker = Buffer.from(commit + "\n");
      await fs.writeFile(path.join(temp, "DEPLOYED_COMMIT"), marker, {
        mode: 0o444,
      });
      files.push({
        path: "DEPLOYED_COMMIT",
        mode: 0o444,
        sha256: hash(marker),
      });
      await atomicJson(path.join(temp, MANIFEST), {
        version: 1,
        commit,
        files,
        evidence: { operator_bootstrap: true, source, verified_ci: false },
      });
      await verifyRelease(temp, commit);
      await fs.rename(temp, release);
      return { commit, release };
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true });
      throw error;
    }
  });
}
