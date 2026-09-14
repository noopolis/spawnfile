import { dirname, join } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { readPrivateFile, type VerifiedNativeLaunch } from '../receipt/index.js';

export function nativeChildArguments(launch: VerifiedNativeLaunch, trialId: string, timeoutMs: number): string[] {
  return ['--experimental-strip-types', launch.bootstrap ? join(launch.bootstrap.root, launch.bootstrap.entrypoint) : join(launch.workerRoot, 'worker/cli.js'),
    '--launch', launch.receiptFile, '--config', launch.config, '--config-sha256', launch.configSha256,
    '--control-root', launch.controlRoot, '--token-file', launch.tokenFile, '--evidence', join(launch.controlRoot, 'evidence.json'),
    '--trial-id', trialId, '--timeout-ms', String(timeoutMs), '--schedule-override', 'disabled'];
}
export async function validateChildPaths(launch: VerifiedNativeLaunch): Promise<void> {
  for (const projection of [launch.workspace, ...launch.projections]) {
    if (projection.source !== projection.target) throw new Error('Child execution requires actual source and target paths to match');
  }
  for (const credential of launch.credentials) {
    const target = await lstat(credential.target);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1 || (target.mode & 0o777) !== 0o600 || await realpath(credential.target) !== credential.target) {
      throw new Error('Caller-owned native credential ingress was not safely staged');
    }
    const directory = await lstat(dirname(credential.target));
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) throw new Error('Caller-owned native credential directory is unsafe');
  }
}
/** Docker env-file semantics: literal values, no shell expansion or inherited host provider settings. */
export async function nativeChildEnvironment(launch: VerifiedNativeLaunch): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const keys = new Set<string>();
  for (const line of (await readPrivateFile(launch.envFile, 65536)).split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match || keys.has(match[1]!)) throw new Error('Invalid explicit native child environment');
    keys.add(match[1]!); env[match[1]!] = match[2]!;
  }
  return env;
}
