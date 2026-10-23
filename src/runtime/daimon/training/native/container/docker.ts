import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { nativeMounts } from './manifest.js';
import { containerSecurityOptions } from './preflight.js';
import { containerPaths, type VerifiedNativeLaunch, type NativeMount } from '../receipt/index.js';

export interface DockerResult { code: number; stdout: string; stderr: string }
export type DockerCommand = (args: string[], options?: { signal?: AbortSignal; timeoutMs?: number; stdin?: string }) => Promise<DockerResult>;
export interface ContainerInspection {
  Id: string;
  State: { Running: boolean; Status: string; ExitCode: number };
  Config: { Labels?: Record<string, string>; Image: string };
}
export const ownerLabel = 'paideia.daimon-native.owner';
export const trialLabel = 'paideia.daimon-native.trial';

export function dockerCommand(command = 'docker'): DockerCommand {
  return async (args, options = {}) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('Docker operation aborted')); return; }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const abort = (reason = 'Docker operation aborted'): void => {
      failure ??= new Error(reason);
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const onAbort = (): void => abort();
    const timer = setTimeout(() => abort('Docker operation deadline exceeded'), options.timeoutMs ?? 15_000);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', bytes => { stdout += String(bytes); if (Buffer.byteLength(stdout) > 16_777_216) abort('Docker output exceeded its bound'); });
    child.stderr.on('data', bytes => { stderr += String(bytes); if (Buffer.byteLength(stderr) > 65536) abort('Docker diagnostics exceeded their bound'); });
    child.stdin.on('error', () => undefined);
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(force); options.signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure); else resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.stdin);
  });
}

export function createContainerArguments(launch: VerifiedNativeLaunch, name: string, owner: string, trialId: string,
  timeoutMs: number, user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`): string[] {
  const security = containerSecurityOptions(launch);
  const mounts: NativeMount[] = [...nativeMounts(launch),
    { source: launch.config, target: containerPaths.config, readonly: true },
    { source: launch.tokenFile, target: containerPaths.token, readonly: true },
    { source: launch.controlRoot, target: containerPaths.control, readonly: false },
    { source: launch.workerRoot, target: containerPaths.worker, readonly: true },
    { source: launch.receiptFile, target: containerPaths.receipt, readonly: true },
    ...(launch.bootstrap ? [{ source: launch.bootstrap.root, target: containerPaths.bootstrap, readonly: true }] : []),
  ];
  return ['create', '--name', name, '--label', `${ownerLabel}=${owner}`, '--label', `${trialLabel}=${trialId}`,
    '--pull', 'never', '--init', '--read-only', '--user', user, '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', ...security, '--pids-limit', '256',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456', '--tmpfs', '/run:rw,nosuid,nodev,size=16777216',
    '--env-file', launch.envFile, '--workdir', '/opt/paideia',
    ...mounts.flatMap(mount => ['--mount', `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ',readonly' : ''}`]),
    '--entrypoint', '/usr/local/bin/node', launch.image, '--experimental-strip-types',
    launch.bootstrap ? posix.join(containerPaths.bootstrap, launch.bootstrap.entrypoint) : `${containerPaths.worker}/worker/cli.js`,
    '--launch', containerPaths.receipt, '--config', containerPaths.config, '--config-sha256', launch.configSha256, '--control-root', containerPaths.control,
    '--token-file', containerPaths.token, '--evidence', `${containerPaths.control}/evidence.json`, '--trial-id', trialId,
    '--timeout-ms', String(timeoutMs), '--schedule-override', 'disabled'];
}

export async function inspectOwned(run: DockerCommand, name: string, owner: string): Promise<ContainerInspection | undefined> {
  const result = await run(['inspect', name, '--format', '{{json .}}']);
  if (result.code !== 0) {
    if (/No such (?:object|container)/iu.test(result.stderr)) return undefined;
    throw new Error('Cannot inspect native container ownership');
  }
  const value = JSON.parse(result.stdout) as ContainerInspection;
  if (value.Config?.Labels?.[ownerLabel] !== owner || typeof value.State?.Running !== 'boolean') {
    throw new Error('Native container ownership or state mismatch');
  }
  return value;
}

/**
 * `node:http` rather than `fetch`: a working worker holds the socket open for as
 * long as its turn takes, and undici's ambient 300-second header timeout would
 * kill a healthy one well inside a legitimate deadline. Here the caller's own
 * deadline is the only bound, as it already was for the surrounding exec.
 */
const httpScript = `import {readFile} from 'node:fs/promises';
import {request} from 'node:http';
const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>resolve(s));}));
const token=(await readFile(input.tokenFile,'utf8')).trim();
const payload=input.body===undefined?undefined:JSON.stringify(input.body);
const value=await new Promise((resolve,reject)=>{
const call=request({host:'127.0.0.1',port:input.port,path:input.path,method:payload===undefined?'GET':'POST',signal:AbortSignal.timeout(input.timeoutMs),headers:{authorization:'Bearer '+token,...(payload===undefined?{}:{'content-type':'application/json'})}},response=>{
let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk});
response.on('end',()=>{let parsed;try{parsed=JSON.parse(text)}catch(error){reject(error);return}
if(response.statusCode<200||response.statusCode>299){reject(Error('Native HTTP '+response.statusCode+': '+JSON.stringify(parsed)));return}
resolve(parsed)})});
call.on('error',reject);if(payload!==undefined)call.write(payload);call.end()});
process.stdout.write(JSON.stringify(value));`;

export async function workerRequest<T>(run: DockerCommand, name: string, path: string, body?: unknown,
  timeoutMs = 5000, signal?: AbortSignal, port = 19700, tokenFile: string = containerPaths.token): Promise<T> {
  const result = await run(['exec', '-i', name, '/usr/local/bin/node', '--input-type=module', '-e', httpScript],
    { signal, timeoutMs: timeoutMs + 2000, stdin: JSON.stringify({ path, body, timeoutMs, port, tokenFile }) });
  if (result.code !== 0) throw new Error(`Native worker request failed: ${result.stderr.slice(-2000)}`);
  return JSON.parse(result.stdout) as T;
}
