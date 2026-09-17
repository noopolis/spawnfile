import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isGrokLaunch, readPrivateFile, sha256, within, type NativeLaunch } from '../receipt/index.js';
import type { NativeConfig, WorkerOptions } from './types.js';

export function parseWorkerArguments(args: readonly string[]): WorkerOptions {
  const keys = ['launch', 'config', 'config-sha256', 'control-root', 'token-file', 'evidence', 'trial-id', 'timeout-ms', 'schedule-override'];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !key || !keys.includes(key) || values.has(key) || !value) {
      throw new Error('Worker arguments require one explicit value for each supported option');
    }
    values.set(key, value);
  }
  if (keys.some(key => !values.has(key))) throw new Error(`Required worker options: ${keys.join(', ')}`);
  const timeoutMs = Number(values.get('timeout-ms'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw new Error('Invalid worker timeout');
  const configSha256 = values.get('config-sha256')!;
  if (!/^[a-f0-9]{64}$/u.test(configSha256)) throw new Error('Expected config SHA-256 is required');
  if (values.get('schedule-override') !== 'disabled') throw new Error('Explicit isolated schedule override is required');
  const result: WorkerOptions = { launch: values.get('launch')!, config: values.get('config')!, configSha256,
    controlRoot: values.get('control-root')!, tokenFile: values.get('token-file')!, evidence: values.get('evidence')!,
    trialId: values.get('trial-id')!, timeoutMs, scheduleOverride: 'disabled' };
  for (const value of [result.launch, result.config, result.controlRoot, result.tokenFile, result.evidence]) {
    if (!isAbsolute(value)) throw new Error('Worker paths must be absolute');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(result.trialId)) throw new Error('Invalid trial identity');
  if (!within(result.controlRoot, result.evidence) || result.evidence === result.controlRoot) throw new Error('Terminal evidence must be inside the protected control root');
  return result;
}

export function assertNativeProfile(config: NativeConfig, launch: NativeLaunch): void {
  const agent = config.agents[0];
  if (config.version !== 'noopolis.daimon.organization-runtime.v2' || config.agents.length !== 1 || agent?.id !== launch.agent.id) {
    throw new Error('Native config must contain exactly the selected agent');
  }
  if (isGrokLaunch(launch)) {
    if (agent.engine.kind !== 'grok' || agent.engine.model !== launch.agent.model || agent.engine.reasoningEffort !== launch.agent.reasoningEffort) {
      throw new Error('Only the declared Grok model and reasoning effort are supported');
    }
    if (agent.engine.codexSandbox !== undefined) throw new Error('Grok broker trials cannot declare a Codex sandbox');
    if (launch.broker.limits.maxTokens > launch.limits.wakeTokenCeiling) throw new Error('Grok broker token limit exceeds the launch wake ceiling');
  } else {
    if (agent.engine.kind !== 'codex' || agent.engine.model !== launch.agent.model) throw new Error('Only the declared Codex model is supported');
    const sandbox = agent.engine.codexSandbox;
    if (!sandbox || sandbox.mode !== 'workspace-write' || sandbox.networkAccess !== false || sandbox.webSearch !== 'disabled') {
      throw new Error('Native trials require the Codex workspace-no-network sandbox');
    }
  }
  if (!agent.attention) throw new Error('Native trials require durable attention admission');
  if (agent.schedule?.kind !== 'disabled') throw new Error('The receipted isolated schedule override must be applied');
  if (config.host.bindHost !== launch.host.bindHost || config.host.port !== launch.host.port) throw new Error('Native host differs from the declared loopback endpoint');
  const home = launch.projections.find(row => row.role === 'home')!;
  if (agent.workspacePath !== launch.workspace.target || agent.runtimeHomePath !== home.target) throw new Error('Native workspace or home projection identity mismatch');
  if (agent.memory && !launch.projections.some(row => row.role === 'memory' && row.target === agent.memory!.runtimeHomePath)) {
    throw new Error('Native Mneme state requires its declared fresh memory projection');
  }
  if (launch.limits.maxTokens > agent.attention.maxTokens) throw new Error('Trial token budget exceeds native attention policy');
}

export async function verifyWorkerPaths(config: NativeConfig, options: WorkerOptions, launch: NativeLaunch): Promise<void> {
  const agent = config.agents[0]!;
  for (const file of [options.launch, options.config, options.tokenFile]) {
    if ((await realpath(file)) !== file) throw new Error('Worker control files must not traverse symlinks');
    if (within(agent.workspacePath, file)) throw new Error('Worker controls must be outside the writable workspace');
  }
  if (within(agent.workspacePath, options.controlRoot) || within(options.controlRoot, agent.workspacePath)) throw new Error('The protected control root must be separate from the workspace');
  const entry = await lstat(options.controlRoot);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || await realpath(options.controlRoot) !== options.controlRoot) {
    throw new Error('The control root must be a private real directory');
  }
  if (((await lstat(options.tokenFile)).mode & 0o077) !== 0) throw new Error('The control token file must be private');
  const instructions = await readPrivateFile(join(agent.workspacePath, launch.instructions.relativePath));
  const rendering = launch.instructions.rendering;
  const nativeInstructions = rendering.prefix + instructions.trim() + rendering.suffix;
  if (!instructions.trim() || sha256(instructions) !== launch.instructions.sha256 || agent.instructions !== nativeInstructions ||
      sha256(agent.instructions) !== rendering.nativeSha256) {
    throw new Error('Declared candidate bytes are absent from the compiled native instructions');
  }
}
