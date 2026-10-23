import { join } from 'node:path';
import { parseNativeSandboxReceipt, readPrivateFile, type VerifiedNativeLaunch } from '../receipt/index.js';
import type { DockerCommand } from './docker.js';

/** Exact owner-projected policy; fresh config home because sandbox lacks exec's isolation flags. */
export const nativePolicyProbeScript = `
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>resolve(s));}));
const projection=input.projection;
const scratch=await mkdtemp(join(projection.workspacePath,'.paideia-native-policy-'));
try {
  const home=join(scratch,'home'), code=join(home,'.codex'), source=join(scratch,'input'), output=join(scratch,'complete');
  await mkdir(code,{recursive:true,mode:448});
  await writeFile(source,'NATIVE_WORKSPACE_READ',{mode:384});
  const command='const fs=require("node:fs");if(process.cwd()!=='+JSON.stringify(projection.workspacePath)+'||fs.readFileSync('+JSON.stringify(source)+',"utf8")!=="NATIVE_WORKSPACE_READ")throw Error("Native workspace read failed");fs.writeFileSync('+JSON.stringify(output)+',"NATIVE_POLICY_EXECUTED");';
  await promisify(execFile)(projection.executablePath,[...projection.sandboxArgs,'--','/usr/local/bin/node','-e',command],{
    cwd:projection.workspacePath,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:code,TMPDIR:'/tmp',LANG:'C.UTF-8'},timeout:12000,maxBuffer:65536});
  if(await readFile(output,'utf8')!=='NATIVE_POLICY_EXECUTED')throw Error('Native sandbox command did not complete');
  process.stdout.write(JSON.stringify({schema:'paideia.daimon-native.policy-preflight.v1',projectionSha256:input.projectionSha256,modelCallsMade:0,workspaceReadWrite:true}));
} finally {await rm(scratch,{recursive:true,force:true});}
`;

export async function verifyPreparedNativeSandbox(run: DockerCommand, name: string, launch: VerifiedNativeLaunch,
  trialId: string, signal?: AbortSignal): Promise<{ projectionSha256: string; workspaceReadWrite: true }> {
  const home = launch.projections.find(projection => projection.role === 'home')!;
  const receipt = parseNativeSandboxReceipt(JSON.parse(await readPrivateFile(join(launch.controlRoot, 'sandbox-projection.json'), 262144)), {
    trialId, configSha256: launch.configSha256, agentId: launch.agent.id, workspacePath: launch.workspace.target, runtimeHomePath: home.target,
  });
  const result = await run(['exec', '-i', name, '/usr/local/bin/node', '--input-type=module', '-e', nativePolicyProbeScript], {
    signal, timeoutMs: 15_000, stdin: JSON.stringify({ path: 'native-policy-preflight', projectionSha256: receipt.projectionSha256, projection: receipt.projection }),
  });
  if (result.code !== 0) throw new Error(`Exact native sandbox policy failed before cognition: ${result.stderr.slice(-3000)}`);
  const proof = JSON.parse(result.stdout) as Record<string, unknown>;
  if (proof.schema !== 'paideia.daimon-native.policy-preflight.v1' || proof.projectionSha256 !== receipt.projectionSha256 ||
    proof.modelCallsMade !== 0 || proof.workspaceReadWrite !== true) throw new Error('Exact native sandbox probe omitted bound workspace execution evidence');
  return { projectionSha256: receipt.projectionSha256, workspaceReadWrite: true };
}
