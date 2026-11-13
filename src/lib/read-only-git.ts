import os from "node:os";
import {childEnvironment} from "./child-environment.js";
export function readOnlyGitEnvironment():NodeJS.ProcessEnv{
 const env=childEnvironment();for(const key of Object.keys(env))if(key.startsWith("GIT_"))delete env[key];
 return {...env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:os.devNull,GIT_OPTIONAL_LOCKS:"0",GIT_TERMINAL_PROMPT:"0",GIT_PAGER:"cat"};
}
export function readOnlyGitArguments(args:string[]):string[]{
 return ["--no-pager","-c","core.fsmonitor=false","-c","core.pager=cat","-c","log.showSignature=false",...args];
}
