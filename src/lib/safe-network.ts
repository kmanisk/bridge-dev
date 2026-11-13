import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export function isPublicAddress(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    const [a,b,c] = ip.split(".").map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&(b===168||(b===0&&(c===0||c===2))||(b===88&&c===99))) || (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19||(b===51&&c===100))) || (a===203&&b===0&&c===113));
  }
  // Only global-unicast IPv6; reject mapped, NAT64, tunneling, local and documentation ranges.
  if(isIP(ip)!==6)return false;
  const canonical=new URL("https://["+ip+"]").hostname.slice(1,-1);
  const [first,second]=canonical.split(":").map(part=>parseInt(part||"0",16));
  return first>=0x2000 && first<=0x3fff && first!==0x2002 && first!==0x3fff && !(first===0x2001&&(second<0x200||second===0xdb8));
}
export async function validateNetworkUrl(input: string, allowPrivate = false): Promise<{url:URL; address:string; family:number}> {
  const url = new URL(input);
  if(url.username || url.password || url.hash || !["https:","http:"].includes(url.protocol))throw new Error("SOURCE_URL_UNSAFE: HTTPS without embedded credentials required");
  if(url.protocol!=="https:" && !allowPrivate)throw new Error("SOURCE_HTTPS_REQUIRED");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const records = isIP(host) ? [{address:host,family:isIP(host)}] : await lookup(host,{all:true});
  if(!records.length || (!allowPrivate && records.some(record=>!isPublicAddress(record.address))))throw new Error("SOURCE_SSRF_DENIED: non-public target");
  return {url,...records[0]};
}
/** Every request resolves and validates all addresses, then pins the actual connection.
 * Redirects are refused here; source adapters may follow them after revalidation.
 */
export function safeFetch(allowPrivate = false, maxBytes = 4 * 1024 * 1024): (input:string|URL, init?:RequestInit)=>Promise<Response> {
  return async (input, init = {}) => {
    const {url,address,family} = await validateNetworkUrl(String(input),allowPrivate);
    if(init.body != null && typeof init.body!=="string" && !Buffer.isBuffer(init.body))throw new Error("Unsupported request body");
    return new Promise((resolve,reject) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const request = (url.protocol==="https:"?https:http).request(url,{
        method:init.method || "GET", headers, agent:false,
        lookup:((_host:unknown, options:any, callback:Function) => options.all ? callback(null,[{address,family}]) : callback(null,address,family)) as any,
        signal:init.signal || undefined,
      }, response => {
        if(Number(response.headers["content-length"] || 0)>maxBytes){response.destroy();reject(new Error("DOWNLOAD_SIZE_LIMIT"));return;}
        let total=0,complete=false;
        const outHeaders = new Headers();
        for(const [key,value] of Object.entries(response.headers))if(value)outHeaders.set(key,Array.isArray(value)?value.join(", "):value);
        const status=response.statusCode || 500;
        if([204,205,304].includes(status)){response.resume();resolve(new Response(null,{status,headers:outHeaders}));return;}
        // Explicit cancellation state avoids the Node 22 toWeb adapter race in
        // which a queued data event enqueues after the consumer cancels SSE.
        const body=new ReadableStream<Uint8Array>({
          start(controller){
            const finish=(error?:Error)=>{if(complete)return;complete=true;error?controller.error(error):controller.close();};
            response.on("data",(chunk:Buffer)=>{
              if(complete)return;
              total+=chunk.length;
              if(total>maxBytes){finish(new Error("DOWNLOAD_SIZE_LIMIT"));response.destroy();return;}
              controller.enqueue(new Uint8Array(chunk));
              if((controller.desiredSize||0)<=0)response.pause();
            });
            response.on("end",()=>finish());response.on("error",error=>finish(error));
          },
          pull(){response.resume();},
          cancel(){complete=true;response.destroy();request.destroy();},
        });
        resolve(new Response(body,{status,headers:outHeaders}));
      });
      request.setTimeout(15000,()=>request.destroy(new Error("NETWORK_TIMEOUT")));
      request.once("error",reject);
      request.end(init.body || undefined);
    });
  };
}
export async function downloadHttps(input:string, maxBytes=1024*1024):Promise<Buffer> {
  let current=input;
  for(let redirects=0;redirects<=3;redirects++) {
    const response=await safeFetch(false,maxBytes)(current,{signal:AbortSignal.timeout(20000)});
    if(response.status>=300&&response.status<400){
      const location=response.headers.get("location"); await response.body?.cancel();
      if(!location)throw new Error("Redirect without location");
      current=new URL(location,current).href; continue;
    }
    if(!response.ok){await response.body?.cancel();throw new Error("SOURCE_HTTP_"+response.status);}
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("SOURCE_REDIRECT_LIMIT");
}
