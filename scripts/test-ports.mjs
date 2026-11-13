import net from 'node:net';

// Hold all reservations together so the OS cannot return the same port twice
// within one fixture. Release immediately before launching its processes.
export async function fixturePorts(count){
 const servers=[];
 try{
  for(let i=0;i<count;i++){
   const server=net.createServer();servers.push(server);
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  }
  return servers.map(server=>server.address().port);
 }finally{await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));}
}
