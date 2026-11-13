import path from "node:path";
import type { PolicyConfig } from "./policy-gateway.js";
import { checkPath } from "./policy-paths.js";

export interface CommandCheck { deny?: string; approval: boolean; reasons: string[]; }
type Token = { raw: string; text: string; operator: boolean };
const SHELLS = new Set(["sh","bash","zsh","fish","dash","ksh"]);
const INTERPRETERS = new Set(["python","python3","node","perl","ruby","php","awk","sed"]);
const APPROVAL_VERBS = new Set(["sudo","doas","pkexec","su","eval","systemctl","ssh","scp","nc","netcat",
  "ncat","socat","pacman","yay","paru","apt","apt-get","dnf","rpm","pip","pip3","npm","pnpm","npx","bun","cargo","make"]);
const DENIED_DISK = new Set(["mkfs","mkfs.ext4","mkfs.btrfs","mkfs.vfat","wipefs"]);
const WRAPPERS = new Set(["env","nohup","setsid","timeout","nice","ionice","stdbuf","command"]);
const READONLY_VERBS = new Set(["ls","pwd","cat","head","tail","rg","grep","find","stat","file","echo","printf",
  "free","uptime","df","du","uname","whoami","id","date","true","false","test","[","which","type","wc","sort","cut"]);
const OP = new Set(["|","||","&&",";","&",">",">>","<","<<","<<<","2>","1>","2>>","1>>"]);

export function tokenizeShell(input: string): Token[] {
  const tokens: Token[] = [];
  let raw = "", text = "", quote: "'" | '"' | null = null, escaped = false;
  const flush = () => { if (raw) { tokens.push({raw,text,operator:false}); raw="";text=""; } };
  for (let i=0;i<input.length;i++) {
    const c=input[i];
    if (escaped) {raw+=c;text+=c;escaped=false;continue;}
    if (c==="\\" && quote!=="'") {raw+=c;escaped=true;continue;}
    if (quote) {
      raw+=c;
      if(c===quote){quote=null;} else text+=c;
      continue;
    }
    if (c==="'" || c==='"') {raw+=c;quote=c;continue;}
    if (c===" " || c==="\t" || c==="\r" || c==="\n") {
      flush(); if(c==="\n") tokens.push({raw:";",text:";",operator:true});
      continue;
    }
    if ("|&;<>".includes(c)) {
      flush();
      let op=c;
      if (c===">" && i+1<input.length && input[i+1]===">") op+=input[++i];
      else if (c==="<" && i+1<input.length && input[i+1]==="<") {
        op+=input[++i]; if (i+1<input.length && input[i+1]==="<") op+=input[++i];
      } else if ((c==="|" || c==="&") && i+1<input.length && input[i+1]===c) op+=input[++i];
      tokens.push({raw:op,text:op,operator:true});continue;
    }
    // In 2>file the fd prefix is attached to the redirect; split it.
    if (/[12]/.test(c) && !raw && input[i+1]===">") {
      let op=c+input[++i]; if(input[i+1]===">") op+=input[++i];
      tokens.push({raw:op,text:op,operator:true});continue;
    }
    raw+=c;text+=c;
  }
  if (quote || escaped) throw new Error("POLICYGATE_COMMAND_UNPARSEABLE: unterminated quote or escape");
  flush();
  return tokens;
}
function segmentCommand(tokens: Token[]): Array<{ argv: Token[]; connector?: string }> {
  const segments: Array<{ argv: Token[]; connector?: string }> = [];
  let argv: Token[] = [];
  for (const token of tokens) {
    if (["|","||","&&",";","&"].includes(token.text) && token.operator) {
      segments.push({argv,connector:token.text});argv=[];
    } else argv.push(token);
  }
  segments.push({argv});
  return segments;
}
function expand(t: string): string {
  return t === "~" ? "$HOME" : t.startsWith("~/") ? "$HOME/"+t.slice(2) : t;
}
function looksLikePath(value: string): boolean {
  return /^(\/|~|\$HOME|\.|[^:]+\/)/.test(value) || /[*?]/.test(value);
}
function safePath(value: string, config: PolicyConfig, policyFile: string, cwd: string, write=false): void {
  // Executing a shell glob here can expand to secret names that the gateway
  // never receives as individual arguments. No safe post-expansion filter
  // exists at this layer: require the filtered native glob/grep tools instead.
  if (/[?*\[]/.test(value)) danger("unresolved shell glob; use the native filtered glob/grep tools");
  checkPath(expand(value),write?"W":"R",config,policyFile,cwd);
}
function danger(code: string): never { throw new Error("POLICYGATE_COMMAND_DENIED: "+code); }
function identifyCommand(argv: Token[], config: PolicyConfig, policyFile: string, cwd: string, depth: number):
  { verb:string; approval:boolean; reasons:string[]; cwd:string } {
  if(depth>5) danger("nested command depth exceeded");
  const words=argv.map(x=>x.text), first=words[0]||"";
  if(!first) return {verb:"",approval:false,reasons:[],cwd};
  if(words.some(w=>/\$\(|\$\{|\x60/.test(w))) return {verb:path.basename(first),approval:true,reasons:["command substitution or environment expansion"],cwd};
  const verb=path.basename(first);
  const reasons:string[] = [];
  let approval=false;
  const normalized=words.join(" ");
  if (config.denied_commands.some(rule => normalized===rule || normalized.startsWith(rule+" ")))
    danger("operator-denied command: "+verb);
  if (config.approval_commands.some(rule => normalized===rule || normalized.startsWith(rule+" "))) {
    approval=true;reasons.push("operator approval command: "+verb);
  }
  const check = (v:string, write=false) => safePath(v,config,policyFile,cwd,write);
  if(verb==="cd" || verb==="pushd") {
    const next=words[1]||"$HOME";check(next);
    const home = process.env.HOME || path.dirname(config.context_files[0]);
    const absolute = next === "~" || next === "$HOME" ? home
      : next.startsWith("~/") ? path.join(home, next.slice(2))
      : next.startsWith("$HOME/") ? path.join(home, next.slice(6)) : path.resolve(cwd,next);
    return {verb,approval:false,reasons:[],cwd:absolute};
  }
  if (DENIED_DISK.has(verb) || /^mkfs\./.test(verb)) danger("filesystem formatting is forbidden");
  if(verb==="dd" && words.some(w=>/^of=\/?dev\//.test(w))) danger("raw device writes are forbidden");
  if(verb===":" && words.includes("(){") || /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&/.test(words.join(" ")))
    danger("fork bomb");
  if (verb==="rm" && words.slice(1).some(w=>/^-.*r.*f|^-.*f.*r/.test(w)) &&
      words.slice(1).some(w=>/^(\/|\/\*|~|\$HOME|\.\.|\/$|\/etc|\/boot|\/usr|\/var|\/root)$/.test(w)))
    danger("broad recursive deletion");
  // Shell rg and find traverse directories without invoking the MCP secret-path
  // filter; even default rg can read non-hidden credentials.json files.
  // Require the gateway-filtered native grep, glob, and directory_tree tools.
  if (verb==="rg" || verb==="find") danger("unfiltered recursive scanner; use native MCP grep/glob/directory_tree");
  // Recursive shell grep cannot reliably exclude .env/SSH/GPG secrets.
  if ((verb==="grep" && words.some(w => /^-[^-]*[rR]/.test(w) || /^--recursive$/.test(w))) ||
      (verb==="rg" && words.some(w => /^(--hidden|--no-ignore|--files|--glob)$/.test(w))) ||
      (verb==="find" && words.some(w => /^(-exec|-execdir|-ok|-okdir|-delete|-fprint|-fprintf)$/.test(w)))) {
    danger("unfiltered recursive search or find side effect; use native grep/glob tools");
  }
  // sed scripts may write or execute using w/W/e and other extensions,
  // without any visible shell redirect or --in-place flag.
  if (verb==="sed") danger("sed may write or execute from its script; use native read/edit tools");
  if (verb==="git") {
    // Global Git options can precede the actual subcommand. Never mistake a
    // -C directory or -c configuration value for the Git operation itself.
    let sub="";
    for(let i=1;i<words.length;i++) {
      if(["-C","-c","--git-dir","--work-tree","--config-env"].includes(words[i])) {i++;continue;}
      if(words[i].startsWith("-"))continue;
      sub=words[i];break;
    }
    if(sub==="push" && words.some(w=>/^(--force|-f|--mirror|--delete)$/.test(w))) danger("git force push");
    const readOnly=["status","diff","log","show","rev-parse","ls-files"].includes(sub);
    // Repository-configured external diffs, fsmonitor and filters can execute
    // even for Git CLI commands commonly mistaken for read-only operations.
    approval=true;reasons.push("Git CLI may execute configured helpers; use native Git tools");
    if(!readOnly || words.some(w=>w==="-c" || w.startsWith("-c") || w.startsWith("--config-env"))) {
      approval=true;reasons.push("Git action or injected config may execute/write");
    }
    const mutates=!readOnly;
    checkPath(cwd,mutates?"W":"R",config,policyFile);
    for(let i=1;i<words.length;i++) {
      if(["-C","--git-dir","--work-tree"].includes(words[i]) && words[i+1])
        check(words[++i],mutates);
      else if(/^(--git-dir=|--work-tree=|-C[^ ]+)/.test(words[i]))
        check(words[i].startsWith("-C")?words[i].slice(2):words[i].split("=").slice(1).join("="),mutates);
    }
  }
  if (verb==="chezmoi" && words.includes("apply")) {approval=true;reasons.push("chezmoi apply");}
  if (APPROVAL_VERBS.has(verb)) {approval=true;reasons.push("privileged or arbitrary tool: "+verb);}
  if (INTERPRETERS.has(verb) && words.some(w=>/^-([ce]|command|eval)$/.test(w))) {
    approval=true;reasons.push("inline interpreter execution");
  }
  if (SHELLS.has(verb) && words.some(w=>/^-([a-z]*c|command)$/.test(w))) {
    const index=words.findIndex(w=>/^-([a-z]*c|command)$/.test(w));
    approval=true;reasons.push("nested shell -c");
    if (index+1<words.length) {
      const nested=analyzeCommand(words[index+1],config,policyFile,cwd,depth+1);
      if(nested.deny) danger(nested.deny);
      reasons.push(...nested.reasons);
    }
  }
  if (verb==="env" || verb==="nohup" || verb==="setsid" || verb==="timeout" ||
      verb==="nice" || verb==="ionice" || verb==="stdbuf" || verb==="command") {
    let idx=1;
    while(idx<words.length && (words[idx].startsWith("-") || (verb==="env" && /^[A-Za-z_][A-Za-z_0-9]*=/.test(words[idx])) ||
        (verb==="timeout" && /^\d+(\.\d+)?[smh]?$/.test(words[idx])))) idx++;
    if (idx>=words.length) danger("wrapper without executable");
    const nested=analyzeCommand(words.slice(idx).join(" "),config,policyFile,cwd,depth+1);
    if(nested.deny) danger(nested.deny);
    approval=approval||nested.approval;reasons.push(...nested.reasons);
  }
  if(verb==="xargs") {approval=true;reasons.push("xargs executes its arguments");}
  if (verb==="curl" || verb==="wget") {
    if(words.some(w=>/^(--upload-file|-T|--data|--data-binary|--form|-F|--request|-X)$/.test(w))) {
      approval=true;reasons.push("HTTP upload or mutation");
    }
  }
  if (words.some(w=>/(?:127\.0\.0\.1|localhost|\[::1\]):(?:3001|\$\{?ADMIN_PORT\}?)(?:\/|\b)/i.test(w)) ||
    words.some(w=>/\/api\/(?:config\/env|local-tools|upstream)/.test(w)))
    danger("MCP operator admin API is forbidden from tool execution");
  if (words.some(w=>/https?:\/\/(?:localhost|127\.0\.0\.1)(?:\b|:)/i.test(w) && /\/api\//i.test(w)))
    danger("loopback operator admin API is forbidden");
  // Explicit read path arguments: conservative check, including shell globs and sensitive segments.
  if(["cat","head","tail","grep","rg","find","ls","stat","file","wc","sort","cut","sed","cp","mv","rm","tee","install","chmod","chown","git"].includes(verb)) {
    const idx = verb==="git" ? words.indexOf("--") : 0;
    for(const w of words.slice(1)) {
      if (w.startsWith("-") || w==="--") continue;
      if(verb==="git" && !looksLikePath(w)) continue;
      // Bare relative filenames are still paths: "cat id_test" or
      // "cp file protected" must not bypass secret/protected checks.
      check(w, ["cp","mv","rm","tee","install","chmod","chown"].includes(verb));
    }
  }
  if(!READONLY_VERBS.has(verb) && !["git","cd","pushd","chezmoi"].includes(verb)) {
    if (!config.allowed_commands.some(prefix=>prefix===verb || words.join(" ").startsWith(prefix+" "))) {
      approval=true;reasons.push("not in command allowlist: "+verb);
    }
  }
  return {verb,approval,reasons,cwd};
}
/** Conservative shell analyzer. Does not execute anything. */
export function analyzeCommand(command:string, config:PolicyConfig, policyFile:string,
  startCwd=process.env.WORKSPACE_PATH?.split(";")[0]||process.cwd(),depth=0):CommandCheck {
  if(typeof command!=="string" || command.length>config.limits.max_payload_bytes)
    return {deny:"command exceeds configured payload limit",approval:false,reasons:[]};
  if(depth>5) return {deny:"nested command depth exceeded",approval:false,reasons:[]};
  if (/(:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&)/.test(command))
    return {deny:"fork bomb syntax",approval:false,reasons:[]};
  if (/\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs)\b/.test(command))
    return {deny:"filesystem formatting command",approval:false,reasons:[]};
  if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:\/|\/\*|~|\$HOME|\.\.)(?:[\s;]|$)/.test(command) ||
      /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+(?:\/|\/\*|~|\$HOME|\.\.)(?:[\s;]|$)/.test(command))
    return {deny:"catastrophic recursive deletion",approval:false,reasons:[]};
  if (/\bdd\b[^\n;]*\bof=\/dev\//.test(command))
    return {deny:"raw device write",approval:false,reasons:[]};
  if (/\b(?:cat|curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python|perl|ruby)\b/.test(command))
    return {deny:"pipe-to-interpreter",approval:false,reasons:[]};
  if (/(?:localhost|127\.0\.0\.1|\[::1\]):3001\b|\/api\/(?:config\/env|local-tools|upstream)/.test(command))
    return {deny:"operator admin API access",approval:false,reasons:[]};
  const reasons:string[]=[];let approval=false;
  try {
    const toks=tokenizeShell(command), groups=segmentCommand(toks);
    let cwd=startCwd;
    for (let index=0;index<groups.length;index++) {
      const group=groups[index];
      if(group.connector==="|" && groups[index+1]) {
        const nextVerb=path.basename(groups[index+1].argv[0]?.text||"");
        if(SHELLS.has(nextVerb) || INTERPRETERS.has(nextVerb))
          return {deny:"pipe-to-interpreter",approval:false,reasons:[]};
      }
      const argv:Token[]=[];
      for(let j=0;j<group.argv.length;j++){
        const tok=group.argv[j];
        if(OP.has(tok.text) && tok.operator && [">",">>","1>","2>","1>>","2>>","<","<<","<<<"].includes(tok.text)) {
          if(tok.text==="<<" || tok.text==="<<<") {approval=true;reasons.push("heredoc/here-string requires review");}
          const file=group.argv[++j];
          if(!file) return {deny:"missing redirect target",approval:false,reasons:[]};
          if(tok.text==="<<" || tok.text==="<<<") continue;
          safePath(file.text,config,policyFile,cwd,tok.text.includes(">"));
        } else argv.push(tok);
      }
      if (argv.length) {
        const result=identifyCommand(argv,config,policyFile,cwd,depth);
        cwd=result.cwd;
        approval=approval||result.approval;
        reasons.push(...result.reasons);
        if(result.verb==="git" && argv.some(w=>w.text==="reset")) approval=true;
      }
    }
  } catch(err) {return {deny:err instanceof Error ? err.message : String(err),approval:false,reasons:[]};}
  // Shell analysis is heuristic: any nontrivial executable can have unseen
  // side effects (awk, sort -o, dynamic scripts, Git drivers, etc.). Require
  // signed out-of-band approval unless this is an exact diagnostic command.
  if(!/^(?:pwd|id|whoami)$/.test(command.trim()) && !approval){
    approval=true;reasons.push("shell execution not on exact diagnostic allowlist");
  }
  return {approval,reasons};
}
