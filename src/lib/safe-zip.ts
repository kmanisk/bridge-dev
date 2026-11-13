import {inflateRawSync} from "node:zlib";
import {safeRelative} from "./extension-sources.js";
function crc32(bytes:Buffer):number{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function extractZip(bytes:Buffer):Record<string,Buffer>{
 if(bytes.length>16*1048576)throw new Error("ZIP_SIZE_LIMIT");
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0 || bytes.readUInt16LE(end+4)!==0 || bytes.readUInt16LE(end+6)!==0)throw new Error("ZIP_INVALID_OR_MULTIDISK");
 const count=bytes.readUInt16LE(end+10);let offset=bytes.readUInt32LE(end+16),total=0;
 if(count>512)throw new Error("ZIP_FILE_COUNT_LIMIT");const result:Record<string,Buffer>={};
 for(let i=0;i<count;i++){
  if(offset+46>bytes.length || bytes.readUInt32LE(offset)!==0x02014b50)throw new Error("ZIP_INVALID_DIRECTORY");
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),crc=bytes.readUInt32LE(offset+16),compressed=bytes.readUInt32LE(offset+20),size=bytes.readUInt32LE(offset+24),length=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),mode=bytes.readUInt32LE(offset+38)>>>16,local=bytes.readUInt32LE(offset+42);
  const name=bytes.subarray(offset+46,offset+46+length).toString("utf8");safeRelative(name.replace(/\/$/,""));
  if(flags&1 || ![0,8].includes(method) || size>1048576 || (total+=size)>16*1048576 || (mode&0o170000)===0o120000 || (mode&0o170000)&&![0o100000,0o040000].includes(mode&0o170000))throw new Error("ZIP_UNSAFE_ENTRY");
  if(local+30>bytes.length || bytes.readUInt32LE(local)!==0x04034b50)throw new Error("ZIP_INVALID_LOCAL_HEADER");
  const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
  if(start+compressed>bytes.length)throw new Error("ZIP_TRUNCATED");
  const data=bytes.subarray(start,start+compressed),decoded=method===8?inflateRawSync(data,{maxOutputLength:1048576}):data;
  if(decoded.length!==size || crc32(decoded)!==crc)throw new Error("ZIP_INTEGRITY_INVALID");
  if(!name.endsWith("/")){if(name in result)throw new Error("ZIP_DUPLICATE");result[name]=decoded;}
  offset+=46+length+extra+comment;
 }
 return result;
}
