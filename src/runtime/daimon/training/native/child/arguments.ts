import { dirname, join } from 'node:path';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { nativeTrialArtifactsRoot, readPrivateFile, type VerifiedNativeLaunch } from '../receipt/index.js';

export function nativeChildArguments(launch: VerifiedNativeLaunch, trialId: string, timeoutMs: number): string[] {
  return ['--experimental-strip-types', launch.bootstrap ? join(launch.bootstrap.root, launch.bootstrap.entrypoint) : join(launch.workerRoot, 'worker/cli.js'),
    '--launch', launch.receiptFile, '--config', launch.config, '--config-sha256', launch.configSha256,
    '--control-root', launch.controlRoot, '--token-file', launch.tokenFile,
    '--evidence', join(nativeTrialArtifactsRoot(launch, trialId), 'evidence.json'),
    '--trial-id', trialId, '--timeout-ms', String(timeoutMs), '--schedule-override', 'disabled'];
}

/**
 * Creates this trial's private artifact directory before the worker starts.
 *
 * A Codex control root is already per-trial, so it is returned untouched. A Grok
 * slot control root is fixed by the container and shared across trials: the
 * non-recursive `mkdir` below is what separates them, and it fails with EEXIST
 * rather than colliding with, or silently overwriting, the previous trial's
 * exclusive artifacts. Nothing outside this directory is Paideia's to clear, so
 * the slot supervisor's recycle never has to wipe on Paideia's behalf.
 */
export async function ensureNativeTrialArtifacts(launch: VerifiedNativeLaunch, trialId: string): Promise<string> {
  const root = nativeTrialArtifactsRoot(launch, trialId);
  if (root === launch.controlRoot) return root;
  const shared = dirname(root);
  await mkdir(shared, { recursive: true, mode: 0o700 });
  await chmod(shared, 0o700);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return root;
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
  const home = launch.projections.find(row => row.role === 'home');
  if (!home || home.source !== home.target) throw new Error('Native child HOME requires the verified materialized home projection');
  const env: NodeJS.ProcessEnv = { HOME: home.target };
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const keys = new Set<string>(['HOME']);
  for (const line of (await readPrivateFile(launch.envFile, 65536)).split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match || keys.has(match[1]!)) throw new Error('Invalid explicit native child environment');
    keys.add(match[1]!); env[match[1]!] = match[2]!;
  }
  return env;
}
