import { lstat, realpath, readdir } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import type { SubjectStart } from '../../../contracts/execution.js';
import { containerPaths, parseNativeLaunch, readPrivateFile, sha256, within, type NativeLaunch, type VerifiedNativeLaunch, type NativeMount } from '../receipt/index.js';

export function nativeMounts(launch: NativeLaunch): NativeMount[] {
  return [{ ...launch.workspace, readonly: false },
    ...launch.projections.map(({ source, target }) => ({ source, target, readonly: false })),
    ...launch.credentials.map(row => ({ ...row, readonly: true }))];
}

/** Only fresh subtrees explicitly projected by trusted preparation enter the subject. */
export async function loadNativeLaunch(input: SubjectStart): Promise<VerifiedNativeLaunch> {
  const receiptFile = join(input.runtimeHomePath, 'native-launch.json');
  const launch = parseNativeLaunch(JSON.parse(await readPrivateFile(receiptFile, 65536)));
  const workspace = await realpath(input.workspacePath);
  const runtime = await realpath(input.runtimeHomePath);
  if (input.model !== launch.agent.model) throw new Error('Subject model differs from the prepared native model');
  if (input.tools?.length) throw new Error('Fixture functions cannot replace native runtime tools');
  if (await realpath(launch.workspace.source) !== workspace) throw new Error('Native workspace must be the materialized trial workspace');
  const instructions = await readPrivateFile(join(workspace, launch.instructions.relativePath));
  if (instructions !== input.instructions || sha256(instructions) !== launch.instructions.sha256) {
    throw new Error('Materialized native instruction bytes differ from the declared candidate');
  }
  if (sha256(await readPrivateFile(launch.config)) !== launch.configSha256) throw new Error('Native launch config digest mismatch');
  const control = await realpath(launch.controlRoot);
  if (!within(runtime, control) || control === runtime || within(workspace, control) || (await readdir(control)).length) {
    throw new Error('Native control must be a fresh empty directory within the trial runtime');
  }
  for (const file of [launch.config, launch.tokenFile, launch.envFile]) {
    const path = await realpath(file);
    if (path !== file || !within(runtime, path) || within(workspace, path)) throw new Error('Native control inputs must be private trial files');
    await readPrivateFile(path);
  }
  const protectedRoots = await Promise.all((input.protectedPaths ?? []).map(path => realpath(path)));
  const home = launch.projections.find(row => row.role === 'home')!;
  const targets = new Set<string>();
  const writableSources: string[] = [];
  for (const mount of nativeMounts(launch)) {
    const source = await realpath(mount.source);
    const stat = await lstat(source);
    if (source !== resolve(mount.source) || !stat.isFile() && !stat.isDirectory()) throw new Error('Native bind source must be a real file or directory');
    if (targets.has(mount.target)) throw new Error('Duplicate native bind target');
    targets.add(mount.target);
    if (['/', '/var', '/var/run', '/run', '/proc', '/sys', '/dev', '/etc', '/usr', '/opt', '/home', '/tmp'].includes(mount.target) ||
        mount.target.includes('docker.sock') || source.includes('docker.sock')) throw new Error('Forbidden native bind target');
    if (Object.values(containerPaths).some(target => within(mount.target, target) || within(target, mount.target))) {
      throw new Error('Native bind overlaps worker-owned control paths');
    }
    if (mount.readonly) {
      if (mount.target !== posix.join(home.target, '.daimon-inbound', 'codex-auth') || !stat.isFile() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
        throw new Error('Credential mount must be one private read-only native ingress file');
      }
      const exposedSources = [launch.workspace.source, ...launch.projections.map(row => row.source), launch.workerRoot,
        ...(launch.bootstrap ? [launch.bootstrap.root] : [])];
      if (exposedSources.some(root => within(root, source))) throw new Error('Credential source cannot also be exposed through another native mount');
      continue;
    }
    if (writableSources.some(root => within(root, source) || within(source, root))) {
      throw new Error('Writable native projections cannot overlap or alias the engine credential home');
    }
    writableSources.push(source);
    if (source !== workspace) {
      if (!within(runtime, source) || source === runtime || within(source, control) || within(control, source) ||
          [launch.config, launch.tokenFile, launch.envFile].some(path => within(source, path))) {
        throw new Error('Native projection must be fresh trial data and exclude controls');
      }
      if (mount.target !== home.target && (within(home.target, mount.target) || within(mount.target, home.target))) {
        throw new Error('Native projections cannot alias into the engine home');
      }
    }
    if (protectedRoots.some(root => within(source, root))) throw new Error('Native bind contains evaluator-owned files');
  }
  for (const source of [launch.workerRoot, ...(launch.bootstrap ? [launch.bootstrap.root] : [])]) {
    if (await realpath(source) !== source || !(await lstat(source)).isDirectory() || source === '/' ||
        protectedRoots.some(root => within(source, root) || within(root, source))) throw new Error('Invalid immutable native code mount');
  }
  return { ...launch, receiptFile };
}
