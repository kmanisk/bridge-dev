import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
let addresses=[{address:'8.8.8.8',family:4}],dnsCalls=0,requests=0,redirect=false;
mock.module('node:dns/promises',{namedExports:{lookup:async()=>{dnsCalls++;return addresses;}}});
mock.module('node:https',{defaultExport:{request(url,options,callback){
 requests++;const emitter=new EventEmitter();emitter.setTimeout=()=>{};emitter.destroy=()=>{};
 emitter.end=()=>{options.lookup(url.hostname,{all:true},(error,records)=>{assert.equal(error,null);assert.equal(records[0].address,'8.8.8.8','Connection must use the validated address without a second DNS lookup');});const response=Readable.from([Buffer.from('fixture')]);response.statusCode=redirect?302:200;response.headers=redirect?{location:'https://127.0.0.1/private'}:{};callback(response);};return emitter;
}}});
const {safeFetch,downloadHttps}=await import('../dist/lib/safe-network.js');
assert.equal(await (await safeFetch()('https://public.fixture/file')).text(),'fixture');assert.equal(dnsCalls,1);
addresses=[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}];await assert.rejects(safeFetch()('https://mixed.fixture/file'),/SSRF/);assert.equal(requests,1);
addresses=[{address:'8.8.8.8',family:4}];redirect=true;await assert.rejects(downloadHttps('https://public.fixture/file'),/SSRF/);assert.equal(requests,2,'Redirect to loopback must be refused before making the next request');
console.log('Network fixtures: DNS address pinning, mixed public/private DNS and redirect SSRF refusal PASS');
mock.restoreAll();
