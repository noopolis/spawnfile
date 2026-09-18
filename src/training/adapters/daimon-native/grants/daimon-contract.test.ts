import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grokGrantModels, grokGrantReasoningEfforts } from '../../../contracts/inference-grants.js';
import { createGrokBrokerInference, GrokGrantPool } from '../../../inference/index.js';
import type { ProcessOptions, RunningProcess } from '../../../platform/process/index.js';
import { loadDaimonGrokGrantAuthority } from './authority.js';
import { daimonGrokInferenceClientPin as PIN } from './pins.js';
import { scriptedBrokerSocket } from './test-socket.js';

/** Pins Paideia's broker-grant binding to the installed Daimon (optional peer, absent in plain CI installs). */
let daimon: Record<string, unknown> | undefined;
try {
  // Same indirect specifier as the product loader: the optional peer is absent in a plain
  // `npm ci`, and a literal here would make `tsc --noEmit` fail on an uninstalled module.
  const packageName = '@noopolis/daimon/runtime';
  const loaded = await import(packageName) as Record<string, unknown>;
  if (typeof loaded['EngineBrokerControlClient'] === 'function' && typeof loaded['renderGrokInferenceClientConfig'] === 'function') daimon = loaded;
} catch { /* reported by the visible skip reason below */ }

let broker: Awaited<ReturnType<typeof scriptedBrokerSocket>> | undefined;
let root: string | undefined;
afterEach(async () => { await broker?.close(); broker = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

const token = `inference_${'A'.repeat(43)}`;
const grantFrame = (request: Record<string, unknown>, n: number) => ({ kind: 'inference_grant', grantId: n.toString(16).padStart(32, '0'), token, baseUrl: PIN.proxyBaseUrl,
  model: request['model'], reasoningEffort: request['reasoningEffort'], purpose: request['purpose'], expiresAt: new Date(Date.now() + 600_000).toISOString(),
  limits: { maxRequests: 64, maxTokens: 2_000_000, timeoutMs: 600_000 } });

describe.skipIf(!daimon)('Daimon inference grant contract parity (skipped: @noopolis/daimon/runtime with inference grants is not installed)', () => {
  it('renders production client config bytes that hash to every Paideia pin', async () => {
    broker = await scriptedBrokerSocket(() => undefined);
    const authority = await loadDaimonGrokGrantAuthority(broker.socketPath);
    for (const model of grokGrantModels) for (const reasoningEffort of grokGrantReasoningEfforts) {
      const bytes = authority.renderClientConfig({ baseUrl: PIN.proxyBaseUrl, model, reasoningEffort, envKey: PIN.envKey });
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(PIN.configSha256[model][reasoningEffort]);
      expect(bytes).toContain('max_retries = 0');
      expect(bytes).not.toMatch(/mcp_servers/u);
    }
  });

  it('drives the real Daimon control client: grant, sequential reuse, stale refusal, cap queueing and release', async () => {
    let issued = 0, capRefusals = 2;
    broker = await scriptedBrokerSocket(request => {
      if (request['kind'] === 'release_inference_grant') return { kind: 'inference_grant_released', grantId: request['grantId'], released: true };
      if (request['purpose'] === 'optimizer') return { kind: 'inference_grant_refused', code: 'auth_stale' };
      if (capRefusals-- > 0) return { kind: 'inference_grant_refused', code: 'grant_limit' };
      return grantFrame(request, ++issued);
    });
    const socketPath = broker.socketPath;
    root = await mkdtemp(path.join(tmpdir(), 'paideia-grant-contract-')); await chmod(root, 0o700);
    const pool = new GrokGrantPool({ id: socketPath, authority: () => loadDaimonGrokGrantAuthority(socketPath), capBackoffMs: [1, 2] });
    const seen: { env: NodeJS.ProcessEnv; config: string; model: string }[] = [];
    const process = (options: ProcessOptions): RunningProcess => ({ write: async () => undefined, endInput: () => undefined,
      stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'contract' }),
      completion: (async () => {
        seen.push({ env: options.env, config: await readFile(path.join(options.env['GROK_HOME']!, 'config.toml'), 'utf8'), model: options.args[options.args.indexOf('--model') + 1]! });
        for (const event of [{ type: 'system', subtype: 'init', model: 'daimon-inference-grok', tools: [], mcp_servers: [], apiKeySource: 'user' },
          { type: 'assistant', session_id: 's', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
          { type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', session_id: 's', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]) {
          await options.onLine(JSON.stringify(event), new AbortController().signal);
        }
        return { exitCode: 0, stderr: '', cancelled: false };
      })() });
    const judge = createGrokBrokerInference({ pool, homeRoot: root, purpose: 'judge', reasoningEffort: 'low', process });
    expect(await judge.generate({ prompt: 'a', model: 'grok-4.6' })).toMatchObject({ text: 'ok', model: 'grok-4.6', route: 'grok-broker-grant' });
    await judge.generate({ prompt: 'b', model: 'grok-4.6' });
    expect(issued).toBe(1);
    expect(seen.map(call => call.model)).toEqual(['daimon-inference-grok', 'daimon-inference-grok']);
    expect(createHash('sha256').update(seen[0]!.config).digest('hex')).toBe(PIN.configSha256['grok-4.6'].low);
    expect(seen[0]!.env['DAIMON_INFERENCE_GRANT']).toBe(token);
    const optimizer = createGrokBrokerInference({ pool, homeRoot: root, purpose: 'optimizer', reasoningEffort: 'medium', process });
    await expect(optimizer.generate({ prompt: 'c', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'auth-stale' });
    await pool.close();
    expect(broker.received.filter(frame => frame['kind'] === 'request_inference_grant')).toHaveLength(4);
    expect(broker.received.filter(frame => frame['kind'] === 'release_inference_grant').map(frame => frame['grantId'])).toEqual(['1'.padStart(32, '0')]);
  });
});
