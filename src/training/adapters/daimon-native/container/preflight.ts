import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { VerifiedNativeLaunch } from '../receipt/index.js';
import type { DockerCommand } from './docker.js';
import { verifyPreparedNativeSandbox } from './native-preflight.js';

/** Same namespace compatibility policy as Spawnfile's strict native Codex launch. */
export const codexSandboxContainerSecurity = ['--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined'] as const;
export const sandboxPreflightSchema = 'paideia.daimon-native.sandbox-preflight.v1';
export const sandboxChecks = ['namespace', 'workspaceRead', 'workspaceWrite', 'runDenied', 'authDenied', 'ingressDenied', 'networkDenied'] as const;

/** Shared verbatim by the emitted command and transition tests. A timeout proves nothing. */
export const sandboxNetworkProbeScript = `
let settled=false;
const socket=net.connect({host:'127.0.0.1',port});
const fail=message=>{if(settled)return;settled=true;socket.destroy();process.stderr.write(message);process.exitCode=1;};
socket.once('connect',()=>fail('Sandbox network reachable'));
socket.once('error',()=>{if(settled)return;settled=true;socket.destroy();fs.writeFileSync('complete','SANDBOX_CHECKS_PASSED');});
socket.setTimeout(750,()=>fail('Sandbox network probe timed out'));`;

/** Runs only local sandbox commands with non-secret canaries and a fresh Codex home. */
export const sandboxPreflightScript = `
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:net';
const execute=promisify(execFile);
const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>resolve(s));}));
const scratch=await mkdtemp(join(input.workspace,'.paideia-sandbox-preflight-'));
let controls; let server;
try {
  controls=await mkdtemp(join(input.controlRoot,'.sandbox-preflight-'));
  const home=join(scratch,'home'), workspace=join(scratch,'workspace'), ingress=join(home,'.daimon-inbound');
  await mkdir(join(home,'.codex'),{recursive:true,mode:448}); await mkdir(workspace,{mode:448}); await mkdir(ingress,{mode:448});
  const auth=join(home,'.codex','auth.json'), inbound=join(ingress,'canary'), control=join(controls,'canary');
  await writeFile(auth,'{}',{mode:384}); await writeFile(inbound,'non-secret ingress canary',{mode:384}); await writeFile(control,'non-secret control canary',{mode:384});
  await writeFile(join(workspace,'input'),'read-proof',{mode:384});
  for (const file of [auth,inbound,control]) if (!(await readFile(file)).length) throw Error('Missing outside-sandbox canary');
  server=createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:join(home,'.codex'),TMPDIR:'/tmp',LANG:'C.UTF-8'};
  await execute('bwrap',['--unshare-user','--uid','0','--gid','0','--ro-bind','/','/','--proc','/proc','--dev','/dev','--','/bin/true'],{env,timeout:10000,maxBuffer:65536});
  const profile='permissions={preflight={extends=":workspace",filesystem={":workspace_roots"={"."="write"},"/run"="deny","/proc"="deny",'+JSON.stringify(auth)+'="deny",'+JSON.stringify(ingress)+'="deny"},network={enabled=false}}}';
  const command=\`const fs=require('node:fs'),net=require('node:net');
if(fs.readFileSync('input','utf8')!=='read-proof')throw Error('Workspace read failed');
fs.writeFileSync('output','write-proof');
for(const file of \${JSON.stringify([control,auth,inbound])}) { let denied=false; try{fs.readFileSync(file);}catch{denied=true;} if(!denied)throw Error('Protected canary is readable'); }
const port=\${port};
${sandboxNetworkProbeScript}\`;
  await execute('codex',['sandbox','-P','preflight','-C',workspace,'-c',profile,'--','/usr/local/bin/node','-e',command],{env,timeout:12000,maxBuffer:65536});
  if(await readFile(join(workspace,'complete'),'utf8')!=='SANDBOX_CHECKS_PASSED'||await readFile(join(workspace,'output'),'utf8')!=='write-proof')throw Error('Sandbox did not complete its actual command');
  process.stdout.write(JSON.stringify({schema:'${sandboxPreflightSchema}',modelCallsMade:0,checks:Object.fromEntries(${JSON.stringify(sandboxChecks)}.map(key=>[key,true]))}));
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  if(controls)await rm(controls,{recursive:true,force:true});
  await rm(scratch,{recursive:true,force:true});
}
`;

export async function verifyNativeSandbox(run: DockerCommand, name: string, launch: VerifiedNativeLaunch,
  trialId: string, signal?: AbortSignal): Promise<void> {
  const result = await run(['exec', '-i', name, '/usr/local/bin/node', '--input-type=module', '-e', sandboxPreflightScript], {
    signal, timeoutMs: 25_000, stdin: JSON.stringify({ path: 'sandbox-preflight', workspace: launch.workspace.target, controlRoot: '/run/paideia/control' }),
  });
  if (result.code !== 0) throw new Error(`Native sandbox preflight failed before cognition: ${result.stderr.slice(-3000)}`);
  const proof = JSON.parse(result.stdout) as { schema?: string; modelCallsMade?: number; checks?: Record<string, unknown> };
  if (proof.schema !== sandboxPreflightSchema || proof.modelCallsMade !== 0 || sandboxChecks.some(check => proof.checks?.[check] !== true)) {
    throw new Error('Native sandbox preflight omitted substantive enforcement evidence');
  }
  const nativePolicy = await verifyPreparedNativeSandbox(run, name, launch, trialId, signal);
  await writeFile(join(dirname(launch.receiptFile), 'sandbox-preflight.json'), `${JSON.stringify({ ...proof, trialId,
    image: launch.image, configSha256: launch.configSha256, nativePolicy, outerCompatibility: [...codexSandboxContainerSecurity] }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
