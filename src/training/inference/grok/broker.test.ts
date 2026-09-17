import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import { GrokGrantRefusal } from '../../contracts/inference-grants.js';
import type { ProcessOptions, RunningProcess } from '../../platform/process/index.js';
import { createRoutedInference } from '../routing.js';
import { createGrokBrokerInference, type GrokBrokerInferenceOptions } from './broker.js';
import { fakeGrantAuthority } from './grant-fixtures.js';
import { GrokGrantPool } from './grant-pool.js';

const init = { type: 'system', subtype: 'init', model: 'daimon-inference-grok', tools: [], mcp_servers: [], apiKeySource: 'user' };
const success = [init,
  { type: 'assistant', session_id: 's', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"score":1}' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: '{"score":1}', stop_reason: 'end_turn', session_id: 's',
    usage: { input_tokens: 40000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }];
const staleResult = { type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null,
  errors: ['Internal error: "Unauthorized (401) from http://127.0.0.1:43123/v1/chat/completions: auth_stale\\n\\n  Model:     grok-4.6"'],
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };

interface Seen { options: ProcessOptions; config: string; homeMode: number; promptMode: number; parentHasToken: boolean }
function runner(events: unknown[], seen: Seen[], exitCode = 0, patch: object = {}) {
  return (options: ProcessOptions): RunningProcess => ({ write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => {
      const home = options.env['GROK_HOME']!;
      seen.push({ options, config: await readFile(path.join(home, 'config.toml'), 'utf8'), homeMode: (await stat(home)).mode & 0o777,
        promptMode: (await stat(options.args[options.args.indexOf('--prompt-file') + 1]!)).mode & 0o777,
        parentHasToken: Object.values(process.env).some(value => value?.startsWith('inference_')) });
      try { for (const event of events) await options.onLine(JSON.stringify(event), new AbortController().signal); }
      catch { return { exitCode: 1, stderr: '', cancelled: true }; }
      return { exitCode, stderr: '', cancelled: false, ...patch };
    })(),
  });
}

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'paideia-grant-root-')); await chmod(root, 0o700); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup(events: unknown[] = success, fake = fakeGrantAuthority(), patch: Partial<GrokBrokerInferenceOptions> = {}, exitCode = 0) {
  const seen: Seen[] = [];
  const pool = new GrokGrantPool({ id: '/run/daimon-engine-broker/control.sock', authority: async () => fake.authority });
  const provider = createGrokBrokerInference({ pool, homeRoot: root, purpose: 'judge', reasoningEffort: 'low', process: runner(events, seen, exitCode), ...patch });
  return { provider, seen, fake, pool };
}

it('runs the pinned client model in a private GROK_HOME with the grant token only in the child environment', async () => {
  const { provider, seen, fake } = setup();
  const result = await provider.generate({ prompt: 'Rate.', system: 'Strict judge.', model: 'grok-4.6' });
  expect(result).toMatchObject({ text: '{"score":1}', model: 'grok-4.6', route: 'grok-broker-grant', usage: { inputTokens: 40000, source: 'grok-broker-grant.result.usage.lower-bound' } });
  const [call] = seen, token = call!.options.env['DAIMON_INFERENCE_GRANT']!;
  expect(call!.options.args[call!.options.args.indexOf('--model') + 1]).toBe('daimon-inference-grok');
  expect(call!.options.args[call!.options.args.indexOf('--reasoning-effort') + 1]).toBe('low');
  expect(call!.options.args.slice(call!.options.args.indexOf('--tools'), call!.options.args.indexOf('--permission-mode')))
    .toEqual(['--tools', 'read_file', '--disallowed-tools', 'read_file,search_tool,use_tool', '--deny', '*']);
  expect(Object.keys(call!.options.env).sort()).toEqual(['DAIMON_INFERENCE_GRANT', 'GROK_HOME', 'HOME', 'PATH', 'TMPDIR']);
  expect(call!.options.env['DAIMON_INFERENCE_GRANT']).toMatch(/^inference_T{40}001$/u);
  expect(call!.options.env['GROK_HOME']!.startsWith(root + path.sep)).toBe(true);
  expect(call!.options.env['HOME']).toBe(call!.options.cwd);
  expect(call!.config).toBe(fake.authority.renderClientConfig({ baseUrl: 'http://127.0.0.1:43123/v1', model: 'grok-4.6', reasoningEffort: 'low', envKey: 'DAIMON_INFERENCE_GRANT' }));
  expect(call!.homeMode).toBe(0o700); expect(call!.promptMode).toBe(0o600);
  expect(call!.parentHasToken).toBe(false);
  expect(JSON.stringify(call!.options.args)).not.toContain(token);
  expect(call!.config).not.toContain(token);
  await expect(lstat(call!.options.env['GROK_HOME']!)).rejects.toThrow();
  expect(fake.requests).toEqual([{ model: 'grok-4.6', reasoningEffort: 'low', purpose: 'judge' }]);
  expect(fake.releases).toEqual([]);
});

it('reuses the lane grant sequentially and labels the capability with its shared credential authority', async () => {
  const { provider, fake } = setup();
  await provider.generate({ prompt: 'a', model: 'grok-4.6' });
  await provider.generate({ prompt: 'b', model: 'grok-4.6' });
  expect(fake.requests).toHaveLength(1);
  expect(provider.capabilities.credentialAuthority).toBe('grok-broker-grant:/run/daimon-engine-broker/control.sock');
});

it('refuses client config bytes that do not match the pin, before launching, and releases the grant', async () => {
  for (const pin of [() => 'f'.repeat(64), () => undefined, () => 'short']) {
    const fake = fakeGrantAuthority({ pinnedClientConfigSha256: pin });
    const { provider, seen } = setup(success, fake);
    await expect(provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('pinned digest') });
    expect(seen).toHaveLength(0);
    expect(fake.releases).toHaveLength(1);
  }
  const drifted = fakeGrantAuthority();
  const render = drifted.authority.renderClientConfig;
  drifted.authority.renderClientConfig = input => `${render(input)}max_retries = 5\n`;
  const { provider, seen } = setup(success, drifted);
  await expect(provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  expect(seen).toHaveLength(0);
});

it('rejects an OAuth init (desktop login) in grant mode and releases the grant', async () => {
  const fake = fakeGrantAuthority();
  const { provider } = setup([{ ...init, apiKeySource: 'oauth' }, ...success.slice(1)], fake);
  await expect(provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'authentication' });
  expect(fake.releases).toHaveLength(1);
});

it('fails a stale realm fast: one CLI call, grant released, no retry on the same authority, other authorities still fall back', async () => {
  const fake = fakeGrantAuthority();
  const { provider, seen, pool } = setup([init, staleResult], fake, {}, 1);
  const twin = createGrokBrokerInference({ pool, homeRoot: root, purpose: 'judge', reasoningEffort: 'medium', process: runner(success, seen) });
  let claude = 0;
  const other: InferenceProvider = { id: 'claude-subscription', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: async () => { claude++; return { text: 'ok', model: 'claude', route: 'claude', usage: null }; } };
  const routed = createRoutedInference({ id: 'judge', routes: [{ provider, model: 'grok-4.6' }, { provider: twin, model: 'grok-4.5' }, { provider: other, model: 'claude' }], maxAttempts: 3, timeoutMs: 10_000 });
  const answer = await routed.generate({ prompt: 'p', model: 'x' });
  expect(seen).toHaveLength(1);
  expect(claude).toBe(1);
  expect(answer.attempts?.map(attempt => attempt.failureKind)).toEqual(['auth-stale', null]);
  expect(fake.releases).toHaveLength(1);
  const refusedAtGrant = fakeGrantAuthority({ refusals: [new GrokGrantRefusal('auth_stale')] });
  const denied = setup(success, refusedAtGrant);
  await expect(denied.provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'auth-stale' });
  expect(denied.seen).toHaveLength(0); expect(refusedAtGrant.requests).toHaveLength(1);
});

it('fails closed without a broker, pin or private home and never launches a desktop Grok', async () => {
  const seen: Seen[] = [];
  const unavailable = new GrokGrantPool({ id: 'unset', authority: async () => { throw new Error('PAIDEIA_GROK_BROKER_CONTROL_SOCKET is not set'); } });
  const noBroker = createGrokBrokerInference({ pool: unavailable, homeRoot: root, purpose: 'optimizer', reasoningEffort: 'medium', process: runner(success, seen) });
  await expect(noBroker.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  const fake = fakeGrantAuthority();
  const noHome = setup(success, fake, { homeRoot: undefined });
  await expect(noHome.provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  expect(fake.requests).toHaveLength(0);
  await chmod(root, 0o770);
  const shared = setup(success, fake);
  await expect(shared.provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('root') });
  await chmod(root, 0o700);
  const link = path.join(root, 'link'); await symlink(root, link);
  const linked = setup(success, fake, { homeRoot: link });
  await expect(linked.provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  const missing = setup(success, fake, { homeRoot: path.join(root, 'absent') });
  await expect(missing.provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  for (const envKey of ['HOME', 'bad-key', 'DAIMON_INFERENCE_GRANT_V2', 'XAI_API_KEY', 'daimon_inference_grant']) {
    const reserved = fakeGrantAuthority({ envKey });
    await expect(setup(success, reserved).provider.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  }
  expect(seen.length + noHome.seen.length + shared.seen.length + linked.seen.length + missing.seen.length).toBe(0);
});

it('rejects off-list models and invalid controls before any grant, and keeps the token out of failures', async () => {
  const fake = fakeGrantAuthority();
  for (const [patch, request] of [[{}, { model: 'grok-4.20' }], [{}, { model: '-x' }], [{}, { prompt: ' ' }], [{}, { seed: 1 }], [{ reasoningEffort: 'xhigh' }, {}], [{ purpose: 'subject' }, {}]] as const) {
    const { provider } = setup(success, fake, patch as Partial<GrokBrokerInferenceOptions>);
    await expect(provider.generate({ ...{ prompt: 'p', model: 'grok-4.6' }, ...request } as Parameters<typeof provider.generate>[0])).rejects.toMatchObject({ kind: 'unsupported' });
  }
  await expect(setup(success, fake).provider.generate({ prompt: 'p', model: 'grok-4.6', signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'cancelled' });
  expect(fake.requests).toHaveLength(0);
  const failing = fakeGrantAuthority();
  const { provider } = setup([init, { ...success[2], subtype: 'error', is_error: true }], failing, {}, 1);
  const failure = await provider.generate({ prompt: 'p', model: 'grok-4.6' }).catch((error: unknown) => error);
  const text = JSON.stringify(failure) + String(failure) + JSON.stringify(Object.getOwnPropertyDescriptors(failure));
  expect(text).not.toContain('inference_');
  expect(failing.releases).toHaveLength(1);
  const cancelled = fakeGrantAuthority();
  const timedOut = setup([init], cancelled, {}, 0);
  const seenCancel = createGrokBrokerInference({ pool: timedOut.pool, homeRoot: root, purpose: 'judge', reasoningEffort: 'low', process: runner([init], [], 0, { cancelled: true }) });
  await expect(seenCancel.generate({ prompt: 'p', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unknown' });
  expect(cancelled.releases).toHaveLength(1);
});
