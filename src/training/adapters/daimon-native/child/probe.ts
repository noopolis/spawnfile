/** Executed verbatim inside the native sandbox; success is an on-disk terminal marker. */
export function nativeChildProbe(input: string, complete: string, denied: readonly string[], port: number): string {
  return `const fs=require('node:fs'),net=require('node:net');
if(fs.readFileSync(${JSON.stringify(input)},'utf8')!=='NATIVE_READ')throw Error('Workspace read failed');
for(const p of ${JSON.stringify(denied)}){let fd;try{fd=fs.openSync(p,'r');}catch{continue;}fs.closeSync(fd);throw Error('Protected path readable');}
let settled=false;const s=net.connect({host:'127.0.0.1',port:${port}});
s.once('connect',()=>{settled=true;s.destroy();process.exitCode=1;});
s.once('error',()=>{if(settled)return;settled=true;s.destroy();fs.writeFileSync(${JSON.stringify(complete)},'NATIVE_POLICY_COMPLETE');});
s.setTimeout(750,()=>{settled=true;s.destroy();process.exitCode=1;});`;
}
