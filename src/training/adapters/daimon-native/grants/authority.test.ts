import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GrokGrantRefusal } from '../../../contracts/inference-grants.js';
import { loadDaimonGrokGrantAuthority, type DaimonGrantModule } from './authority.js';
import { daimonGrokInferenceClientPin as PIN } from './pins.js';
import { scriptedBrokerSocket } from './test-socket.js';

class Refused extends Error { constructor(readonly code: string) { super('refused'); } }
function fakeDaimon(patch: Record<string, unknown> = {}, grants: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const module = {
    EngineBrokerControlClient: class { constructor(readonly socket: string) { calls.push(['socket', socket]); }
      async requestInferenceGrant(request: { purpose: string }) { calls.push(['request', request]); if (request.purpose === 'optimizer') throw new Refused('grant_limit'); if (request.purpose === 'weird') throw new Refused('mystery'); throw new Error('engine broker unavailable'); }
      async releaseInferenceGrant(grantId: string) { calls.push(['release', grantId]); if (grantId === 'stale') throw new Refused('auth_stale'); return true; } },
    EngineBrokerInferenceGrantRefused: Refused,
    renderGrokInferenceClientConfig: (input: { model: string }) => `rendered ${input.model}`,
    GROK_INFERENCE_CLIENT_MODEL_ID: PIN.modelId, GROK_INFERENCE_GRANT_ENV: PIN.envKey, GROK_INFERENCE_PROXY_BASE_URL: PIN.proxyBaseUrl,
    GROK_ENGINE_BROKER: { inferenceGrants: { maxLiveGrants: 8, failureCodes: [...PIN.failureCodes], client: { modelId: PIN.modelId, envKey: PIN.envKey, configSha256: structuredClone(PIN.configSha256) }, ...grants } },
    ...patch,
  };
  return { module: module as unknown as DaimonGrantModule, calls };
}

let broker: Awaited<ReturnType<typeof scriptedBrokerSocket>> | undefined;
afterEach(async () => { await broker?.close(); broker = undefined; });

it('binds the Daimon control client to the supplied socket and maps closed refusals', async () => {
  broker = await scriptedBrokerSocket(() => undefined);
  const { module, calls } = fakeDaimon();
  const authority = await loadDaimonGrokGrantAuthority(broker.socketPath, async () => module);
  expect(authority).toMatchObject({ clientModelId: 'daimon-inference-grok', envKey: 'DAIMON_INFERENCE_GRANT', maxLiveGrants: 8 });
  expect(calls[0]).toEqual(['socket', broker.socketPath]);
  await expect(authority.request({ model: 'grok-4.6', reasoningEffort: 'low', purpose: 'optimizer' })).rejects.toEqual(new GrokGrantRefusal('grant_limit'));
  await expect(authority.request({ model: 'grok-4.6', reasoningEffort: 'low', purpose: 'judge' })).rejects.not.toBeInstanceOf(GrokGrantRefusal);
  await expect(authority.request({ model: 'grok-4.6', reasoningEffort: 'low', purpose: 'weird' as 'judge' })).rejects.not.toBeInstanceOf(GrokGrantRefusal);
  await expect(authority.release('stale')).rejects.toEqual(new GrokGrantRefusal('auth_stale'));
  await expect(authority.release('a'.repeat(32))).resolves.toBe(true);
  expect(authority.renderClientConfig({ baseUrl: PIN.proxyBaseUrl, model: 'grok-build', reasoningEffort: 'high', envKey: PIN.envKey })).toBe('rendered grok-build');
  expect(authority.pinnedClientConfigSha256('grok-4.5', 'medium')).toBe(PIN.configSha256['grok-4.5'].medium);
  expect(authority.pinnedClientConfigSha256('grok-9' as 'grok-4.5', 'medium')).toBeUndefined();
});

it('fails closed without a socket, without Daimon, or when the installed contract drifts from the pin', async () => {
  broker = await scriptedBrokerSocket(() => undefined);
  const socket = broker.socketPath;
  const { module } = fakeDaimon();
  for (const value of [undefined, 'relative.sock', path.join(path.dirname(socket), 'missing.sock')]) {
    await expect(loadDaimonGrokGrantAuthority(value, async () => module)).rejects.toThrow(/socket/u);
  }
  const plain = path.join(path.dirname(socket), 'file.sock'); await writeFile(plain, '');
  await expect(loadDaimonGrokGrantAuthority(plain, async () => module)).rejects.toThrow('unavailable');
  await expect(loadDaimonGrokGrantAuthority(socket, async () => { throw new Error('missing'); })).rejects.toThrow('optional @noopolis/daimon');
  const drifted = structuredClone(PIN.configSha256) as Record<string, Record<string, string>>;
  drifted['grok-4.6']!['low'] = createHash('sha256').update('other').digest('hex');
  for (const patch of [{ renderGrokInferenceClientConfig: undefined }, { GROK_ENGINE_BROKER: {} }, { EngineBrokerControlClient: undefined }, { EngineBrokerInferenceGrantRefused: undefined }]) {
    await expect(loadDaimonGrokGrantAuthority(socket, async () => fakeDaimon(patch).module)).rejects.toThrow('lacks evaluator inference grants');
  }
  for (const [patch, grants] of [[{ GROK_INFERENCE_CLIENT_MODEL_ID: 'grok-4.6' }, {}], [{ GROK_INFERENCE_GRANT_ENV: 'XAI_API_KEY' }, {}], [{ GROK_INFERENCE_PROXY_BASE_URL: 'http://127.0.0.1:1/v1' }, {}],
    [{}, { maxLiveGrants: 16 }], [{}, { failureCodes: ['auth_stale'] }], [{}, { client: { modelId: PIN.modelId, envKey: PIN.envKey, configSha256: drifted } }],
    [{}, { client: { modelId: 'x', envKey: PIN.envKey, configSha256: PIN.configSha256 } }], [{}, { client: { modelId: PIN.modelId, envKey: 'X_KEY', configSha256: PIN.configSha256 } }]] as const) {
    await expect(loadDaimonGrokGrantAuthority(socket, async () => fakeDaimon(patch, grants).module)).rejects.toThrow('differs from the Paideia pin');
  }
});

it('scripted broker socket answers length-prefixed frames and closes on an unscripted request', async () => {
  broker = await scriptedBrokerSocket(request => request['kind'] === 'answer' ? { kind: 'ok' } : undefined);
  const exchange = (kind: string) => new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: broker!.socketPath });
    let data = Buffer.alloc(0);
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ version: 'v', requestId: 'r', kind }));
      const frame = Buffer.alloc(4 + body.length); frame.writeUInt32BE(body.length); body.copy(frame, 4);
      socket.write(frame.subarray(0, 3)); setTimeout(() => socket.write(frame.subarray(3)), 5);
    });
    socket.on('data', chunk => { data = Buffer.concat([data, chunk]); socket.destroy(); resolve(data.subarray(4).toString('utf8')); });
    socket.on('close', () => resolve('closed')); socket.on('error', reject);
  });
  expect(JSON.parse(await exchange('answer'))).toEqual({ version: 'v', requestId: 'r', kind: 'ok' });
  expect(await exchange('other')).toBe('closed');
  expect(broker.received.map(frame => frame['kind'])).toEqual(['answer', 'other']);
});

