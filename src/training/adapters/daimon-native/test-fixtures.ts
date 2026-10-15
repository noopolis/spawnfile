import type { NativeActivity, NativeConfig, NativeReceipt, NativeTrace, TerminalEvidence } from './worker/index.js';
import { chmod, mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubjectStart } from '../../contracts/execution.js';
import { bindNativeSandboxProjection, sha256, type NativeSandboxProjection, type VerifiedNativeLaunch } from './receipt/index.js';
import { ownerLabel, type DockerCommand } from './container/index.js';

export function configFixture(root = '/isolated'): NativeConfig {
  return { version: 'noopolis.daimon.organization-runtime.v2',
    host: { bindHost: '127.0.0.1', port: 19700, controlTokenEnv: 'TRIAL_TOKEN' },
    agents: [{ id: 'agent:writer', name: 'writer', instructions: 'Compiler-owned identity',
      workspacePath: `${root}/workspace`, runtimeHomePath: `${root}/runtime`,
      engine: { kind: 'codex', model: 'test-model-v1', codexSandbox: { mode: 'workspace-write', networkAccess: false, webSearch: 'disabled' } },
      attention: { maxBatchMessages: 8, maxBatchBytes: 12000, maxExecutions: 30, maxTokens: 8000000 },
      schedule: { kind: 'disabled' }, memory: { runtimeHomePath: `${root}/memory` },
      moltnet: { cliPath: '/usr/local/bin/moltnet', configPath: `${root}/client.json`,
        networks: [{ id: 'local-test', rooms: ['tasks', 'results'], dms: false }] },
      mcp: [{ name: 'project', transport: 'stdio', command: '/usr/local/bin/node', args: [], env: {}, tools: ['save_record'] },
        { name: 'validation', transport: 'stdio', command: '/usr/local/bin/node', args: [], env: {}, tools: ['validate_record'] }] }] };
}
export const executionId = '11111111-1111-4111-8111-111111111111';
export function receiptFixture(): NativeReceipt {
  return { version: 'noopolis.daimon.wake-receipt-status.v2', acceptance_id: '22222222-2222-4222-8222-222222222222',
    agent_id: 'agent:writer', delivery_id: 'trial:wake', request_digest: 'a'.repeat(64), state: 'completed',
    accepted_at: '2026-09-13T00:00:00.000Z', updated_at: '2026-09-13T00:00:01.000Z', execution_id: executionId, text: '' };
}
export function traceFixture(): NativeTrace {
  return { schema: 'daimon.turn_trace.v1', agent_id: 'agent:writer', turn_id: executionId,
    started_at: '2026-09-13T00:00:00.000Z', completed_at: '2026-09-13T00:00:01.000Z', status: 'completed', tools: [] };
}
export function activityFixture(active = false): NativeActivity {
  return { version: 'noopolis.daimon.organization-runtime-activity.v2', items: [{ ...receiptFixture(), active }],
    executions: active ? [{ agent_id: 'agent:writer', execution_id: executionId, delivery_ids: ['trial:wake'], state: 'running' }] : [] };
}

/** Terminal failure before admission, matching the retained run-39 public projections. */
export function unadmittedFixture(trialId = 'trial', wakeId = 'task'): TerminalEvidence {
  const receipt = { ...receiptFixture(), delivery_id: `${trialId}:${wakeId}`, state: 'accepted' as const };
  delete receipt.execution_id;
  return { schema: 'paideia.daimon-native.trial.v1', trialId, wakeId, agentId: 'agent:writer', model: 'test-model-v1',
    configSha256: 'a'.repeat(64), scheduleOverride: 'disabled', status: 'failed',
    startedAt: receipt.accepted_at, completedAt: receipt.updated_at, receipt,
    activity: { version: 'noopolis.daimon.organization-runtime-activity.v2', items: [{ ...receipt, active: false }], executions: [] },
    availability: { version: 'noopolis.daimon.work-availability.v1', state: 'paused', agents: [{ agent_id: receipt.agent_id,
      pending: 1, running: false, deferred: 0, budget: { armed: true, epoch: trialId,
        executions_used: 0, agent_executions_used: 0, tokens_used: 0, agent_tokens_used: 0 } }] },
    native: { traces: [], usage: [], toolReceipts: [], modelContexts: [], accounting: { usage: [], coverage: 'absent' } },
    coverage: ['tools', 'output', 'usage'].map(channel => ({ channel: channel as 'tools' | 'output' | 'usage', completeness: 'absent', ordering: 'none' })),
    error: 'Native execution failed before terminal telemetry' };
}

export function sandboxProjectionFixture(agentId = 'agent:writer', workspacePath = '/native/workspace', runtimeHomePath = '/native/home'): NativeSandboxProjection {
  const permissionConfig = 'permissions={unit={extends=":workspace",network={enabled=false}}}';
  return { version: 'noopolis.daimon.codex-sandbox-projection.v1', agentId, workspacePath, runtimeHomePath,
    engineHomePath: `${runtimeHomePath}/.codex`, executablePath: '/unit/codex', profileName: 'unit', permissionConfig,
    sandboxArgs: ['sandbox', '-P', 'unit', '-C', workspacePath, '-c', permissionConfig] };
}
export async function writeSandboxProjectionFixture(launch: VerifiedNativeLaunch, trialId: string): Promise<void> {
  const projection = sandboxProjectionFixture(launch.agent.id, launch.workspace.target, launch.projections.find(item => item.role === 'home')!.target);
  await writeFile(join(launch.controlRoot, 'sandbox-projection.json'), JSON.stringify(bindNativeSandboxProjection(projection, trialId, launch.configSha256)), { mode: 0o600 });
}

export async function launchFixture(): Promise<{ root: string; input: SubjectStart; launch: VerifiedNativeLaunch; save(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-adapter-unit-')));
  const workspace = join(root, 'workspace');
  const runtime = join(root, 'runtime');
  const native = join(runtime, 'native');
  for (const directory of [workspace, join(root, 'control'), join(native, 'home'), join(native, 'memory'), join(native, 'state'),
    join(native, 'inputs'), join(native, 'acceptance'), join(root, 'worker'), join(root, 'bootstrap')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const instructions = 'Compiler-owned identity';
  await writeFile(join(workspace, 'AGENTS.md'), instructions);
  const inputs = join(native, 'inputs');
  const config = configFixture('/native');
  config.agents[0]!.runtimeHomePath = '/native/home';
  const bytes = JSON.stringify(config);
  await writeFile(join(inputs, 'config.json'), bytes);
  await writeFile(join(inputs, 'token'), 'unit-secret-that-is-not-a-login', { mode: 0o600 });
  await writeFile(join(inputs, 'environment'), 'TRIAL_FIXTURE=unit\n');
  const launch: VerifiedNativeLaunch = {
    schema: 'paideia.daimon-native.launch.v1', receiptFile: join(runtime, 'native-launch.json'),
    image: `sha256:${'a'.repeat(64)}`, config: join(inputs, 'config.json'), configSha256: sha256(bytes), sourceConfigSha256: sha256(bytes),
    tokenFile: join(inputs, 'token'), envFile: join(inputs, 'environment'), controlRoot: join(native, 'acceptance'), workerRoot: join(root, 'worker'),
    bootstrap: { root: join(root, 'bootstrap'), entrypoint: 'bootstrap.js' }, host: { bindHost: '127.0.0.1', port: 19700 },
    agent: { id: 'agent:writer', engine: 'codex', model: 'test-model-v1' }, instructions: { relativePath: 'AGENTS.md', sha256: sha256(instructions),
      rendering: { kind: 'trim-surround', prefix: '', suffix: '', nativeSha256: sha256(instructions) } },
    workspace: { source: workspace, target: '/native/workspace' },
    projections: [{ role: 'home', source: join(native, 'home'), target: '/native/home' },
      { role: 'memory', source: join(native, 'memory'), target: '/native/memory' },
      { role: 'state', source: join(native, 'state'), target: '/native/state' }], credentials: [],
    limits: { maxTokens: 8000000, wakeTokenCeiling: 1000000 },
    overrides: { schedule: { before: { kind: 'every', interval_ms: 60000 }, after: { kind: 'disabled' }, reason: 'Isolated single trial' },
      selection: { before: ['agent:writer', 'agent:editor'], after: ['agent:writer'], reason: 'Selected subject only' } },
  };
  const input: SubjectStart = { trialId: 'unit-trial', workspacePath: workspace, runtimeHomePath: runtime,
    protectedPaths: [runtime, join(root, 'control')], instructions, model: 'test-model-v1', onObservation: () => undefined };
  const save = async (): Promise<void> => { const { receiptFile, ...receipt } = launch; await writeFile(receiptFile, JSON.stringify(receipt), { mode: 0o600 }); await chmod(receiptFile, 0o600); };
  await save();
  return { root, input, launch, save };
}

/** Explicit unit command double; never native runtime acceptance evidence. */
export function dockerFixture(launch: VerifiedNativeLaunch, trialId: string) {
  const calls: string[][] = [];
  let owner = ''; let exists = false; let running = false; let forged = false; let stickyStop = false; let terminal: unknown;
  const run: DockerCommand = async (args, options) => {
    calls.push(args);
    const response = (value: unknown) => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    if (args[0] === 'context') return response('"unix:///unit-docker.sock"');
    if (args[0] === 'create') { owner = args.find(value => value.startsWith(`${ownerLabel}=`))!.slice(ownerLabel.length + 1); exists = true; return response('b'.repeat(64)); }
    if (args[0] === 'inspect') return exists ? response({ Id: 'b'.repeat(64), State: { Running: running, Status: running ? 'running' : 'exited', ExitCode: 0 }, Config: { Labels: { [ownerLabel]: forged ? 'foreign' : owner }, Image: launch.image } })
      : { code: 1, stdout: '', stderr: 'Error: No such object' };
    if (args[0] === 'start') { await writeSandboxProjectionFixture(launch, trialId); running = true; return response('started'); }
    if (args[0] === 'logs') return response({ schema: 'paideia.daimon-native.ready.v1', trialId, configSha256: launch.configSha256 });
    if (args[0] === 'exec') {
      const request = JSON.parse(options?.stdin ?? '{}') as { path: string; projectionSha256?: string };
      if (request.path === 'sandbox-preflight') return response({ schema: 'paideia.daimon-native.sandbox-preflight.v1', modelCallsMade: 0,
        checks: { namespace: true, workspaceRead: true, workspaceWrite: true, runDenied: true, authDenied: true, ingressDenied: true, networkDenied: true } });
      if (request.path === 'native-policy-preflight') return response({ schema: 'paideia.daimon-native.policy-preflight.v1',
        projectionSha256: request.projectionSha256, modelCallsMade: 0, workspaceReadWrite: true });
      if (request.path === '/trial/health') return response({ version: 'noopolis.daimon.organization-runtime-health.v1', state: 'running', agents: [{ agentId: launch.agent.id }] });
      if (request.path === '/trial/stop') return response({ state: 'acknowledged' });
      if (request.path === '/trial/run') return response(terminal);
    }
    if (args[0] === 'stop') { if (!stickyStop) running = false; return response('stopped'); }
    if (args[0] === 'kill') { running = false; return response('killed'); }
    if (args[0] === 'rm') { exists = false; return response('removed'); }
    throw new Error(`Unexpected unit Docker command: ${args[0]}`);
  };
  return { run, calls, forgeOwner: () => { forged = true; }, requireKill: () => { stickyStop = true; }, setTerminal: (value: unknown) => { terminal = value; } };
}
