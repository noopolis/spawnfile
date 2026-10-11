import { expect, test, vi } from 'vitest';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { configFixture, launchFixture, receiptFixture, sandboxProjectionFixture, traceFixture } from '../test-fixtures.js';
import { createDeliveryGate, MAX_EXTERNAL_DELIVERIES, MAX_TRIAL_WAKES } from './deliveries.js';
import { grokProjectionSha256, nativeTrialArtifactsRoot, sha256, type GrokBrokerProjection } from '../receipt/index.js';
import { grokConfigFor, grokLaunchFrom, grokProjectionFor, writeGrokSlotReceipt } from '../grok-fixtures.js';
import * as runtime from './public.js';
import { runDaimonNativeWorker } from './worker.js';
import type { NativeHost, NativeConfig, NativeReceipt } from './types.js';

test('worker checks real receipt bytes before boot and serves native authenticated health with an explicit unit host', async () => {
  const f = await launchFixture(); const platform = process.platform; const environment = { ...process.env }; const exitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const signalHandlers: (() => void)[] = [];
  const once = vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') signalHandlers.push(handler);
    return process;
  }) as typeof process.once);
  let failure = ''; let stops = 0;
  const host = { start: async () => { if (failure === 'start') throw new Error('Unit start refusal'); },
    stop: async () => { stops++; return {}; },
    health: async () => ({ version: 'noopolis.daimon.organization-runtime-health.v1', state: failure === 'health' ? 'starting' : 'running', agents: [] }),
    activityV2: async () => failure === 'activity' ? undefined : ({ version: 'native-unit', items: [], executions: [] }) } as unknown as NativeHost;
  const load = vi.spyOn(runtime, 'loadDaimonRuntime').mockResolvedValue({ parseOrganizationRuntimeConfig: value => value as NativeConfig, createOrganizationRuntimeControlHost: () => host,
    resolveOrganizationCodexSandboxProjection: async value => { const agent = (value as NativeConfig).agents[0]!;
      return sandboxProjectionFixture(agent.id, agent.workspacePath, agent.runtimeHomePath); } });
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await expect(runDaimonNativeWorker([])).rejects.toThrow('Linux');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const config = configFixture(f.root);
    config.host.port = 19783;
    f.launch.host.port = config.host.port; f.launch.workspace.target = config.agents[0]!.workspacePath;
    f.launch.projections[0]!.target = config.agents[0]!.runtimeHomePath; f.launch.projections[1]!.target = config.agents[0]!.memory!.runtimeHomePath;
    const bytes = JSON.stringify(config); f.launch.configSha256 = sha256(bytes);
    await writeFile(f.launch.config, bytes); await f.save();
    const args = ['--launch', f.launch.receiptFile, '--config', f.launch.config, '--config-sha256', f.launch.configSha256,
      '--control-root', f.launch.controlRoot, '--token-file', f.launch.tokenFile, '--evidence', join(f.launch.controlRoot, 'evidence'),
      '--trial-id', 'unit-worker', '--timeout-ms', '3600000', '--schedule-override', 'disabled'];
    await expect(runDaimonNativeWorker(args.map(value => value === f.launch.configSha256 ? 'f'.repeat(64) : value))).rejects.toThrow('digest');
    await writeFile(join(f.launch.controlRoot, 'stale'), 'stale'); await expect(runDaimonNativeWorker(args)).rejects.toThrow('empty'); await rm(join(f.launch.controlRoot, 'stale'));
    const token = await readFile(f.launch.tokenFile, 'utf8');
    for (const bad of ['short', 'a'.repeat(24) + '\ninside']) { await writeFile(f.launch.tokenFile, bad); await expect(runDaimonNativeWorker(args)).rejects.toThrow('token'); }
    await writeFile(f.launch.tokenFile, token);
    for (const reason of ['start', 'health', 'activity']) { failure = reason; await expect(runDaimonNativeWorker(args)).rejects.toThrow(); }
    failure = ''; await runDaimonNativeWorker(args);
    expect((await fetch('http://127.0.0.1:19783/trial/health', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(stdout.mock.calls.some(([value]) => String(value).includes('paideia.daimon-native.ready.v1'))).toBe(true);
    signalHandlers[0]!(); signalHandlers[0]!();
    await vi.waitFor(async () => { await expect(fetch('http://127.0.0.1:19783/trial/health')).rejects.toThrow(); });
    expect(stops).toBeGreaterThanOrEqual(4);
    expect(process.env['DAIMON_WAKE_FUSE_MAX_TOKENS']).toBe(String(f.launch.limits.maxTokens));
    expect(process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS).toBe('3600000');
    expect(process.env.DAIMON_CODEX_WAKE_TIMEOUT_MS).toBe('3600000');
    expect(process.env.DAIMON_ENGINE_WAKE_TOKEN_CEILING).toBe('1000000');
    expect(process.env.DAIMON_CODEX_WAKE_TOKEN_CEILING).toBe('1000000');
  } finally {
    load.mockRestore(); once.mockRestore(); stdout.mockRestore(); Object.defineProperty(process, 'platform', { value: platform }); process.exitCode = exitCode;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Grok worker loads the Grok runtime capability, sets engine-neutral limits and reports engine identity when ready', async () => {
  const f = await launchFixture(); const platform = process.platform; const environment = { ...process.env };
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const handlers: (() => void)[] = [];
  const once = vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => { if (event === 'SIGTERM') handlers.push(handler); return process; }) as typeof process.once);
  const host = { start: async () => undefined, stop: async () => ({}),
    health: async () => ({ version: 'noopolis.daimon.organization-runtime-health.v1', state: 'running', agents: [] }),
    activityV2: async () => ({ version: 'native-unit', items: [], executions: [] }) } as unknown as NativeHost;
  const launch = await grokLaunchFrom(f.launch, f.root);
  const engines: string[] = [];
  const load = vi.spyOn(runtime, 'loadDaimonRuntime').mockImplementation(async engine => { engines.push(engine ?? 'codex'); return {
    parseOrganizationRuntimeConfig: value => value as NativeConfig, createOrganizationRuntimeControlHost: () => host,
    resolveOrganizationCodexSandboxProjection: async () => { throw new Error('Grok never resolves a Codex sandbox'); },
    resolveOrganizationGrokBrokerProjection: () => grokProjectionFor(launch), grokBrokerProjectionSha256: value => grokProjectionSha256(value as GrokBrokerProjection),
    verifyGrokSlotPreflightReceipt: value => value }; });
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const config = grokConfigFor(configFixture(f.root));
    config.agents[0]!.runtimeHomePath = launch.projections[0]!.source;
    config.host.port = 19784; launch.host.port = 19784; launch.workspace.target = config.agents[0]!.workspacePath;
    launch.projections[0]!.target = config.agents[0]!.runtimeHomePath;
    const bytes = JSON.stringify(config); launch.configSha256 = sha256(bytes);
    launch.broker.projectionSha256 = grokProjectionSha256(grokProjectionFor(launch));
    await writeFile(launch.config, bytes); await f.save(); await writeGrokSlotReceipt(launch);
    const artifacts = nativeTrialArtifactsRoot(launch, 'unit-grok');
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const token = await readFile(launch.tokenFile, 'utf8');
    const args = ['--launch', launch.receiptFile, '--config', launch.config, '--config-sha256', launch.configSha256,
      '--control-root', launch.controlRoot, '--token-file', launch.tokenFile, '--evidence', join(artifacts, 'evidence'),
      '--trial-id', 'unit-grok', '--timeout-ms', '900000', '--schedule-override', 'disabled'];
    await writeFile(launch.broker.usageLedgerPath, 'not json\n');
    await expect(runDaimonNativeWorker(args)).rejects.toThrow(/valid JSON/);
    await rm(launch.broker.usageLedgerPath);
    await runDaimonNativeWorker(args);
    expect(engines).toEqual(['grok', 'grok']);
    expect(process.env['DAIMON_ENGINE_WAKE_TIMEOUT_MS']).toBe('480000');
    expect(process.env['DAIMON_ENGINE_WAKE_TOKEN_CEILING']).toBe('400000');
    expect(process.env['DAIMON_CODEX_WAKE_TOKEN_CEILING']).toBe(process.env['DAIMON_ENGINE_WAKE_TOKEN_CEILING']);
    expect(process.env['DAIMON_TURN_USAGE_LEDGER_PATH']).toBe(launch.broker.usageLedgerPath);
    expect(process.env['DAIMON_TURN_REQUESTS_LEDGER_PATH']).toBe(join(dirname(launch.broker.usageLedgerPath), 'requests.jsonl'));
    const ready = stdout.mock.calls.map(([value]) => String(value)).find(value => value.includes('paideia.daimon-native.ready.v1'))!;
    expect(JSON.parse(ready)).toMatchObject({ model: 'grok-4.6', engine: 'grok', reasoningEffort: 'low', trialId: 'unit-grok' });
    expect(JSON.parse(await readFile(join(artifacts, 'sandbox-projection.json'), 'utf8')).schema).toBe('paideia.daimon-native.grok-broker-projection.v1');
    expect(process.env['DAIMON_RUNTIME_ACCEPTANCE_STORE']).toBe(artifacts);
    expect((await fetch('http://127.0.0.1:19784/trial/health', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    handlers[0]!();
    await vi.waitFor(async () => { await expect(fetch('http://127.0.0.1:19784/trial/health')).rejects.toThrow(); });
  } finally {
    load.mockRestore(); once.mockRestore(); stdout.mockRestore(); Object.defineProperty(process, 'platform', { value: platform });
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the published wake ceiling admits every continuation the delivery gate accepts, so a second wake really executes', async () => {
  const f = await launchFixture(); const platform = process.platform; const environment = { ...process.env }; const exitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const handlers: (() => void)[] = [];
  const once = vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') handlers.push(handler); return process;
  }) as typeof process.once);
  const config = configFixture(f.root);
  config.host.port = 19785;
  const home = config.agents[0]!.runtimeHomePath;
  let admissions = 0;
  let receipt: NativeReceipt = { ...receiptFixture(), state: 'accepted', execution_id: undefined };
  // Daimon's own wake fuse, as `wakeFuse.ts` implements it: an execution is admitted
  // only while the epoch's admissions stay under DAIMON_WAKE_FUSE_MAX_WAKES. Over it
  // the delivery stays accepted and nothing ever runs — the live deadlock.
  const admit = async (deliveryId: string): Promise<void> => {
    if (admissions >= Number(process.env['DAIMON_WAKE_FUSE_MAX_WAKES'])) {
      receipt = { ...receiptFixture(), delivery_id: deliveryId, state: 'accepted', deferred: false, execution_id: undefined };
      return;
    }
    const execution = `${++admissions}1111111-1111-4111-8111-111111111111`;
    await mkdir(join(home, '.codex/sessions'), { recursive: true });
    await mkdir(join(home, 'telemetry'), { recursive: true });
    await writeFile(join(home, '.codex/sessions/unit.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
    await appendFile(join(f.launch.controlRoot, 'usage.jsonl'), `${JSON.stringify({ v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer',
      wake: execution, engine: 'codex', at: '2026-09-13T00:00:01.000Z', input: 10, output: 2, cache_read: 0, total: 12, complete: true })}\n`);
    await appendFile(join(home, 'telemetry/turns.ndjson'), `${JSON.stringify({ ...traceFixture(), turn_id: execution })}\n`);
    receipt = { ...receiptFixture(), delivery_id: deliveryId, execution_id: execution,
      state: admissions === 1 ? 'accepted' : 'completed', deferred: admissions === 1 };
  };
  const host = { start: async () => undefined, stop: async () => ({ state: 'stopped' }),
    health: async () => ({ version: 'noopolis.daimon.organization-runtime-health.v1', state: 'running', agents: [] }),
    activityV2: async () => ({ version: 'native-unit', items: admissions ? [{ ...receipt, active: false }] : [], executions: [] }),
    availability: async () => ({ state: 'ready', agents: [{ agent_id: 'agent:writer' }] }),
    async accept(request: { delivery_id: string }) { await admit(request.delivery_id); return { state: 'accepted', acceptance_id: receipt.acceptance_id }; },
    wakeReceipt: async () => receipt } as unknown as NativeHost;
  const load = vi.spyOn(runtime, 'loadDaimonRuntime').mockResolvedValue({ parseOrganizationRuntimeConfig: value => value as NativeConfig,
    createOrganizationRuntimeControlHost: () => host,
    resolveOrganizationCodexSandboxProjection: async value => { const agent = (value as NativeConfig).agents[0]!;
      return sandboxProjectionFixture(agent.id, agent.workspacePath, agent.runtimeHomePath); } });
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    f.launch.host.port = config.host.port; f.launch.workspace.target = config.agents[0]!.workspacePath;
    f.launch.projections[0]!.target = home; f.launch.projections[1]!.target = config.agents[0]!.memory!.runtimeHomePath;
    const bytes = JSON.stringify(config); f.launch.configSha256 = sha256(bytes);
    await writeFile(f.launch.config, bytes); await f.save();
    const token = (await readFile(f.launch.tokenFile, 'utf8')).trim();
    await runDaimonNativeWorker(['--launch', f.launch.receiptFile, '--config', f.launch.config, '--config-sha256', f.launch.configSha256,
      '--control-root', f.launch.controlRoot, '--token-file', f.launch.tokenFile, '--evidence', join(f.launch.controlRoot, 'evidence'),
      '--trial-id', 'unit-ceiling', '--timeout-ms', '4000', '--schedule-override', 'disabled']);
    // The ceiling the worker published, against the wakes the real gate will admit.
    const gate = createDeliveryGate(60_000);
    const answer = 'A genuinely supplied external answer';
    const source = { kind: 'transport', id: 'answer-message', sha256: `sha256:${createHash('sha256').update(answer).digest('hex')}` };
    let admitted = 1;
    gate.begin('w0', 'Assigned work', { maxExternalDeliveries: MAX_EXTERNAL_DELIVERIES });
    while (gate.finish(`e${admitted}`, true)) { gate.begin(`w${admitted}`, answer, { source }); admitted++; }
    const deliver = async (body: unknown) => await (await fetch('http://127.0.0.1:19785/trial/run', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Record<string, unknown>;
    const first = await deliver({ wakeId: 'task', text: 'Assigned work', controls: { maxExternalDeliveries: MAX_EXTERNAL_DELIVERIES } });
    expect(first.blocked).toBe('awaiting-external-input');
    const second = await deliver({ wakeId: 'answer', text: answer, controls: { source } });
    expect(second.status, String(second.error)).toBe('completed');
    expect(admissions).toBe(2);
    expect(admitted).toBe(MAX_TRIAL_WAKES);
    expect(Number(process.env['DAIMON_WAKE_FUSE_MAX_WAKES'])).toBe(admitted);
    handlers[0]!();
    await vi.waitFor(async () => { await expect(fetch('http://127.0.0.1:19785/trial/health')).rejects.toThrow(); });
  } finally {
    load.mockRestore(); once.mockRestore(); stdout.mockRestore(); Object.defineProperty(process, 'platform', { value: platform }); process.exitCode = exitCode;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    await rm(f.root, { recursive: true, force: true });
  }
});
