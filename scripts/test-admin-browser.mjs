import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fixturePorts} from './test-ports.mjs';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const binary=process.env.BRIDGEDEV_TEST_BROWSER;if(!binary||!path.isAbsolute(binary))throw Error('Set BRIDGEDEV_TEST_BROWSER to an existing Chromium-compatible executable');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-browser-'));
const [port,adminPort]=await fixturePorts(2),token=randomBytes(32).toString('hex'),admin=randomBytes(32).toString('hex'),work=path.join(root,'work'),source=path.join(root,'guide.md');await fs.mkdir(work);await fs.writeFile(source,'# Browser fixture instructions\n');
const env={...process.env,POLICYGATE_POLICY_FILE:'',BRIDGEDEV_RUNTIME_MODE:'portable',BRIDGEDEV_STATE_DIR:path.join(root,'state'),WORKSPACE_PATH:work,MCP_UPSTREAM_CONFIG:path.join(root,'providers.json'),PORT:String(port),ADMIN_PORT:String(adminPort),MCP_TOKEN:token,ADMIN_TOKEN:admin};
let gateway,browser,ws,logs='';
async function waitFor(action){for(let i=0;i<100;i++){try{const result=await action();if(result)return result;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Browser fixture timeout: '+logs.slice(-1000));}
try{
 gateway=spawn(process.execPath,['dist/index.js'],{env,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',b=>logs+=b);gateway.stdout.on('data',b=>logs+=b);
 await waitFor(async()=>{const r=await fetch(`http://127.0.0.1:${port}/health`);return r.ok;});
 const profile=path.join(root,'browser');
 browser=spawn(binary,['--headless=new','--disable-gpu','--disable-background-networking','--disable-component-update','--disable-sync','--disable-breakpad','--no-first-run','--password-store=basic','--disable-default-apps','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+profile,'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--window-size=1280,900','about:blank'],{env:{PATH:process.env.PATH,HOME:root,XDG_CONFIG_HOME:path.join(root,'browser-config'),XDG_CACHE_HOME:path.join(root,'browser-cache'),TMPDIR:os.tmpdir()},stdio:['ignore','ignore','pipe'],detached:process.platform!=='win32'});
 browser.stderr.on('data',b=>logs+=b);
 const debugPort=await waitFor(async()=>Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]));
 const target=await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${adminPort}/ui/`,{method:'PUT'})).json();
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});let next=0;const pending=new Map();
 ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id&&pending.has(data.id)){const {resolve,reject}=pending.get(data.id);pending.delete(data.id);data.error?reject(Error(JSON.stringify(data.error))):resolve(data.result);}});
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async(expression)=>{const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 await waitFor(()=>evaluate('Boolean(document.getElementById("admin-credential"))'));
 await evaluate(`document.getElementById('admin-credential').value=${JSON.stringify(admin)};document.querySelector('[data-tab="extensions"]').click();refreshAll()`);
 await evaluate(`document.getElementById('extension-source').value=${JSON.stringify(source)};document.getElementById('extension-discover').click()`);
 await waitFor(()=>evaluate('!document.getElementById("extension-approve").hidden'));
 assert.match(await evaluate('document.getElementById("extension-preview").textContent'),/instructions:guide|"kind": "instructions"/);
 await evaluate('document.getElementById("extension-approve").click()');
 await waitFor(()=>evaluate('document.getElementById("extension-installed").textContent.includes("instructions:guide")'));
 assert.match(await evaluate('document.getElementById("extension-result").textContent'),/Applied/);
 const screenshot=await command('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(os.tmpdir(),'bridge-admin-browser.png'),Buffer.from(screenshot.data,'base64'));
 console.log('Admin browser: authenticated login, discovery, exact preview, apply and installed state PASS; screenshot in temporary directory');
}finally{
 ws?.close();
 if(gateway&&gateway.exitCode===null){const exited=new Promise(resolve=>gateway.once('exit',resolve));await fetch(`http://127.0.0.1:${adminPort}/api/lifecycle/stop`,{method:'POST',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json',Connection:'close'},body:'{}'}).catch(()=>gateway.kill());await exited;}
 if(browser&&browser.exitCode===null){try{process.platform==='win32'?browser.kill():process.kill(-browser.pid,'SIGTERM');}catch{}await new Promise(r=>setTimeout(r,200));try{if(browser.exitCode===null)process.platform==='win32'?browser.kill('SIGKILL'):process.kill(-browser.pid,'SIGKILL');}catch{}}
 await fs.rm(root,{recursive:true,force:true});
}
