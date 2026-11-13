import fs from "node:fs/promises";
import path from "node:path";

export interface ExtensionLink { title: string; url: string; }
export interface ExtensionManifest {
  version: 1;
  instructions?: string[];
  skill_directories?: string[];
  links?: ExtensionLink[];
}
export interface LoadedExtensions {
  instructions: Array<{path:string;content:string}>;
  skillDirectories: string[];
  links: ExtensionLink[];
  warnings: string[];
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
function safeRelative(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length < 512 &&
    !path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) &&
    !value.replace(/\\/g, "/").split("/").some((part)=>part === ".." || part === "." || !part);
}
function notSensitive(value:string): boolean {
  return !value.replace(/\\/g,"/").split("/").some(segment =>
    /^(\.env(?:\..*)?|\.ssh|\.gnupg|\.aws|\.kube|private|secrets|credentials\.json|id_.*)$/i.test(segment) ||
    /\.(?:pem|key)$/i.test(segment));
}

export function validateExtensionManifest(raw: unknown): ExtensionManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Extensions manifest must be an object");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || Object.keys(value).some(k=>!["version","instructions","skill_directories","links"].includes(k)))
    throw new Error("Unknown extensions manifest version or key");
  for (const field of ["instructions","skill_directories"] as const) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || (value[field] as unknown[]).length > 16 ||
      !(value[field] as unknown[]).every(v=>typeof v==="string" && safeRelative(v) && notSensitive(v)))) {
      throw new Error("Invalid " + field + " paths (workspace-relative Markdown/skill directories only)");
    }
  }
  if (value.links !== undefined && (!Array.isArray(value.links) || value.links.length>16 ||
      !value.links.every((entry:unknown)=>{
        if (!entry || typeof entry!=="object" || Array.isArray(entry)) return false;
        const link=entry as Record<string,unknown>;
        if (Object.keys(link).some(k=>!["title","url"].includes(k)) || typeof link.title!=="string" ||
            !link.title.trim() || link.title.length>120 || typeof link.url!=="string") return false;
        try {
          const url=new URL(link.url);
          return url.protocol==="https:" && url.username==="" && url.password==="" &&
            url.hostname.length>0 && link.url.length<2000;
        } catch {return false;}
      }))) throw new Error("Links must be HTTPS URLs with labels; links are never fetched automatically");
  return value as unknown as ExtensionManifest;
}

export async function loadExtensions(workspaceRoot:string):Promise<LoadedExtensions> {
  const result:LoadedExtensions={instructions:[],skillDirectories:[],links:[],warnings:[]};
  const root=await fs.realpath(path.resolve(workspaceRoot));
  const manifestPath=path.join(root,".bridge-dev","extensions.json");
  let manifest:ExtensionManifest;
  try {manifest=validateExtensionManifest(JSON.parse(await fs.readFile(manifestPath,"utf8")));}
  catch(error){
    if ((error as NodeJS.ErrnoException).code==="ENOENT")return result;
    result.warnings.push("Invalid extensions configuration: "+(error instanceof Error?error.message:String(error)));
    return result;
  }
  const resolveEntry=async (relative:string,kind:"file"|"directory"):Promise<string>=>{
    const direct=path.resolve(root,relative);
    if (!within(root,direct))throw new Error("Path escapes workspace");
    const real=await fs.realpath(direct);
    if (!within(root,real))throw new Error("Symlink escapes workspace");
    const st=await fs.stat(real);
    if (kind==="file" && (!st.isFile() || st.size>65536 || !real.toLowerCase().endsWith(".md")))
      throw new Error("Instructions must be Markdown files <=64KiB");
    if (kind==="directory" && !st.isDirectory())throw new Error("Skill root must be a directory");
    return real;
  };
  for(const rel of manifest.instructions||[]){
    try {
      const abs=await resolveEntry(rel,"file");
      const content=await fs.readFile(abs,"utf8");
      result.instructions.push({path:abs,content});
    }catch(error){result.warnings.push("Instruction "+rel+": "+String(error));}
  }
  for(const rel of manifest.skill_directories||[]){
    try{result.skillDirectories.push(await resolveEntry(rel,"directory"));}
    catch(error){result.warnings.push("Skill directory "+rel+": "+String(error));}
  }
  result.links=manifest.links||[];
  return result;
}

export function formatExtensionsForInstructions(data:LoadedExtensions):string {
  const sections:string[]=[];
  for(const entry of data.instructions) sections.push("### User-provided Markdown: "+entry.path+"\n"+entry.content);
  if(data.links.length)sections.push("## Reference links (not fetched or trusted as instructions)\n"+
    data.links.map(link=>"- "+link.title+": "+link.url).join("\n"));
  if(data.warnings.length)sections.push("## Unavailable user extensions\n"+data.warnings.join("\n"));
  return sections.join("\n\n");
}
