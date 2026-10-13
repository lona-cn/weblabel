// Synthetic lifecycle fixture only: no Python, detector weights or inference.
import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const [mode,pidPath]=process.argv.slice(2);
writeFileSync(pidPath,String(process.pid));
const keepAlive=setInterval(()=>{},1000);
const send=(kind,method,id,payload)=>process.stdout.write(JSON.stringify({protocol_version:1,kind,method,id,payload})+'\n');
createInterface({input:process.stdin}).once('line',async line=>{
 const request=JSON.parse(line);
 if(request.method==='start_run')writeFileSync(pidPath+'.stage',request.payload.image.path);
 if(mode==='silent')return;
 if(mode==='partial'){process.stdout.write('{"protocol_version":');return;}
 if(mode==='malformed'){process.stdout.write('not-json\n');return;}
 if(mode==='stderr-pressure')for(let i=0;i<512;i++)if(!process.stderr.write('x'.repeat(8192)+'\n'))await new Promise(r=>process.stderr.once('drain',r));
 if(request.method==='probe')send('response','probe',request.id,{ok:true,profile:{model_id:'synthetic-lifecycle',availability:'ready',runtime_version:'synthetic'}});
 else {
  const event=(seq,type,data=null)=>send('event','run_event',request.id,{run_id:request.id,seq,type,message:'synthetic lifecycle',data});
  if(mode==='candidate'){event(1,'candidate',{raw:{synthetic:true}});event(2,'succeeded');}
  else if(mode==='crash'){clearInterval(keepAlive);process.exitCode=7;process.stdin.destroy();return;}
  else event(1,'succeeded');
 }
 if(mode==='response-hang')return;
 clearInterval(keepAlive);process.stdin.destroy();process.exitCode=mode==='crash'?7:0;
});
