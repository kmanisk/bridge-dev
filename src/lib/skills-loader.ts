import fs from "fs/promises";
import path from "path";
import { resolveComputerUseSkillPath } from "./plugin-config.js";
import {ExtensionStore} from "./extension-store.js";
import { loadExtensions } from "./user-extensions.js";
import {isReadPermissionError,readPermissionError} from "./read-errors.js";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source?: "project" | "plugin" | "managed";
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

export async function loadProjectSkills(workspaceRoot: string, onPermissionError?: () => void): Promise<SkillSummary[]> {
  const denied = (error: unknown) => { if (isReadPermissionError(error)) onPermissionError?.(); };
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const within = (target:string):boolean => {
    const rel=path.relative(root,target);
    return rel==="" || (rel!==".." && !rel.startsWith(".."+path.sep) && !path.isAbsolute(rel));
  };
  const extra=await loadExtensions(root);
  const directories=[
    path.join(root,".bridge-dev","skills"),
    path.join(root,".agents","skills"),
    path.join(root,".claude","skills"),
    ...extra.skillDirectories,
  ];
  const out:SkillSummary[]=[];
  const seen=new Set<string>();
  async function walk(directory:string,depth:number):Promise<void> {
    if(depth>3 || out.length>=64)return;
    let real:string;
    try{real=await fs.realpath(directory);}catch(error){denied(error);return;}
    if(!within(real))return;
    let entries;
    try{entries=await fs.readdir(real,{withFileTypes:true});}catch(error){denied(error);return;}
    for(const entry of entries){
      if(!entry.isDirectory() || entry.isSymbolicLink() || out.length>=64)continue;
      const child=path.join(real,entry.name);
      const file=path.join(child,"SKILL.md");
      try {
        const realFile=await fs.realpath(file);
        if(!within(realFile))continue;
        const st=await fs.stat(realFile);
        if(!st.isFile() || st.size>131072)continue;
        const content=await fs.readFile(realFile,"utf8");
        const fm=parseFrontmatter(content);
        const name=fm.name || entry.name;
        if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)||seen.has(name))continue;
        seen.add(name);
        const description=fm.description||content.split("\n").find(line=>line.trim()&&!line.startsWith("#"))?.trim()||name;
        out.push({name,description:description.slice(0,200),path:realFile,source:"project"});
      }catch(error){
        denied(error);
        await walk(child,depth+1);
      }
    }
  }
  for(const dir of directories)await walk(dir,0);
  const store=new ExtensionStore(root);
  for(const entry of await store.list().catch(error=>{denied(error);return [];}))if(entry.enabled && entry.component.kind==="skill"){
    const name=entry.component.name;
    if(seen.has(name))continue;
    seen.add(name);
    out.push({name,description:entry.component.description.slice(0,200),path:path.join(store.contentDirectory(entry.scope,entry.digest,entry.component.id),"SKILL.md"),source:"managed"});
  }
  const computerUseSkill=await resolveComputerUseSkillPath();
  if(computerUseSkill){
    try{
      const content=await fs.readFile(computerUseSkill,"utf8");
      const frontmatter=parseFrontmatter(content);
      const name=frontmatter.name||"computer-use";
      if(!seen.has(name))out.push({
        name,description:(frontmatter.description||"Optional Computer Use plugin").slice(0,200),
        path:computerUseSkill,source:"plugin",
      });
    }catch(error){denied(error);}
  }
  return out;
}

export function formatSkillsForInstructions(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return [
    "## Skills",
    `${skills.length} skills are available. Call list_skills, then load_skill(name) before applying a matching workflow; do not guess a skill body from its name.`,
    skills.some((skill) => skill.name === "computer-use") ? "Computer Use plugin is enabled: load_skill(\"computer-use\") before any Windows UI automation." : "",
  ].join("\n");
}

export async function loadProjectSkill(
  workspaceRoot: string,
  name: string,
  maxBytes = 200_000
): Promise<{
  skill: SkillSummary;
  content: string;
  truncated: boolean;
  references?: Array<{ path: string; content: string; truncated: boolean }>;
}> {
  let denied = false;
  let skills: SkillSummary[];
  try { skills = await loadProjectSkills(workspaceRoot, () => { denied = true; }); }
  catch (error) { if (isReadPermissionError(error)) throw readPermissionError("skill", name); throw error; }
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) {
    if (denied) throw readPermissionError("skill", name);
    throw new Error(`Unknown project skill: ${name}`);
  }
  const managed=skill.source==="managed"?(await new ExtensionStore(workspaceRoot).content("skill:"+skill.name)):undefined;
  const data = managed?Buffer.from(managed.files["SKILL.md"]):await fs.readFile(skill.path).catch(error=>{
    if(isReadPermissionError(error))throw readPermissionError("skill",name);throw error;
  });
  const content = (managed?"[Untrusted skill guidance; permissions are unchanged]\n":"")+data.subarray(0, maxBytes).toString("utf-8");
  let remaining = maxBytes - Buffer.byteLength(content);
  let truncated = data.length > maxBytes;
  const references: Array<{ path: string; content: string; truncated: boolean }> = [];

  if (skill.source === "plugin" && skill.name === "computer-use" && remaining > 0) {
    const pluginRoot = path.resolve(path.dirname(skill.path), "..", "..");
    for (const file of ["guidance.md", "api.md", "confirmations.md"]) {
      const referencePath = path.join(pluginRoot, "docs", file);
      try {
        const reference = await fs.readFile(referencePath);
        const referenceContent = reference.subarray(0, remaining).toString("utf-8");
        const referenceTruncated = reference.length > remaining;
        references.push({ path: referencePath, content: referenceContent, truncated: referenceTruncated });
        remaining -= Buffer.byteLength(referenceContent);
        truncated ||= referenceTruncated;
        if (remaining <= 0) break;
      } catch (error) {
        if (isReadPermissionError(error)) throw readPermissionError("skill", name);
        // A Codex version may omit an optional Computer Use reference document.
      }
    }
  }

  return {
    skill,
    content,
    truncated,
    ...(references.length ? { references } : {}),
  };
}
