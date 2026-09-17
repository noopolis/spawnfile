import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseDatasetYaml } from '../../cases/index.js';
import type { GrokInferenceGrantAuthority, InferenceProvider, TrainingModel } from '../../contracts/index.js';
import { createTrainingInference } from './inference.js';

const yaml = `
schema: paideia.dataset.v1
id: broker
checks:
  - { id: check, eval: contains-any, input: output.text, values: [done] }
records:
  - { id: one, input: { prompt: Write. } }
training:
  models:
    grader: { provider: grok-broker, model: grok-4.6, reasoning_effort: low }
    reflect: { provider: grok-broker, model: grok-4.6, reasoning_effort: medium }
    backup: { provider: claude-subscription, model: claude-sonnet-4-6 }
  judges:
    prose: { model: grader, fallbacks: [backup], attempts: 2 }
  optimizer: { model: reflect }
`;

/** Broker double: sequential grants, recorded requests/releases, and a pin over its own rendered bytes. */
function fakeGrantAuthority() {
  const requests: unknown[] = [], releases: string[] = [];
  const render: GrokInferenceGrantAuthority['renderClientConfig'] = input => `model = "${input.model}"\nbase_url = "${input.baseUrl}"\nenv_key = "${input.envKey}"\n`;
  const authority: GrokInferenceGrantAuthority = { clientModelId: 'daimon-inference-grok', envKey: 'DAIMON_INFERENCE_GRANT', maxLiveGrants: 8,
    request: async input => { requests.push(input); return { grantId: String(requests.length).padStart(32, '0'), token: `inference_${'B'.repeat(43)}`,
      baseUrl: 'http://127.0.0.1:43123/v1', ...input, expiresAt: new Date(Date.now() + 600_000).toISOString(), limits: { maxRequests: 64, maxTokens: 2_000_000, timeoutMs: 600_000 } }; },
    release: async grantId => { releases.push(grantId); return true; }, renderClientConfig: render,
    pinnedClientConfigSha256: (model, reasoningEffort) => createHash('sha256').update(render({ baseUrl: 'http://127.0.0.1:43123/v1', model, reasoningEffort, envKey: 'DAIMON_INFERENCE_GRANT' })).digest('hex') };
  return { authority, requests, releases };
}

let root: string, bin: string;
const saved = { PATH: process.env['PATH'], socket: process.env['PAIDEIA_GROK_BROKER_CONTROL_SOCKET'], home: process.env['PAIDEIA_GROK_GRANT_HOME_ROOT'] };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'paideia-cli-broker-'));
  bin = path.join(root, 'bin');
  await mkdir(bin);
  await mkdir(path.join(root, 'homes'), { mode: 0o700 });
  process.env['PATH'] = `${bin}${path.delimiter}${saved.PATH ?? ''}`;
  process.env['PAIDEIA_GROK_BROKER_CONTROL_SOCKET'] = '/run/daimon-engine-broker/control.sock';
  process.env['PAIDEIA_GROK_GRANT_HOME_ROOT'] = path.join(root, 'homes');
});
afterEach(async () => {
  process.env['PATH'] = saved.PATH;
  for (const [key, value] of [['PAIDEIA_GROK_BROKER_CONTROL_SOCKET', saved.socket], ['PAIDEIA_GROK_GRANT_HOME_ROOT', saved.home]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

/** A real child process named `grok` on PATH: records what it received, then speaks the captured grant protocol. */
async function fakeGrok(outcome: 'success' | 'stale') {
  const log = path.join(root, 'grok-calls.jsonl');
  const init = { type: 'system', subtype: 'init', model: 'daimon-inference-grok', tools: [], mcp_servers: [], apiKeySource: 'user' };
  const frames = outcome === 'success' ? [init,
    { type: 'assistant', session_id: 's', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn', session_id: 's', usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]
    : [init, { type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null,
      errors: ['Internal error: "Unauthorized (401) from http://127.0.0.1:43123/v1/chat/completions: auth_stale\\n\\n  Version:   1.0.34"'] }];
  const script = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, config: fs.readFileSync(process.env.GROK_HOME + '/config.toml', 'utf8') }) + '\\n');
for (const frame of ${JSON.stringify(frames)}) process.stdout.write(JSON.stringify(frame) + '\\n');
process.exitCode = ${outcome === 'success' ? 0 : 1};
`;
  await writeFile(path.join(bin, 'grok'), script); await chmod(path.join(bin, 'grok'), 0o755);
  return async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; env: Record<string, string>; config: string });
}

function build(fake = fakeGrantAuthority(), noAuthority = false) {
  let claude = 0;
  const modelInference = (model: TrainingModel): InferenceProvider => model.provider !== 'claude-subscription' ? undefined as never : { id: 'claude-subscription',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: async () => { claude++; return { text: 'claude', model: 'claude', route: 'claude-subscription', usage: null }; } };
  const training = parseDatasetYaml(yaml).dataset.training;
  const configured = createTrainingInference({ command: 'train', flags: {}, training }, { modelInference, ...(noAuthority ? {} : { grokGrantAuthority: async () => fake.authority }) },
    60_000, { prose: 'grok-4.6' }, { prose: 0 });
  return { configured, fake, claude: () => claude };
}

it('runs YAML grok-broker judges and optimizer through grants with the purpose recorded and a clean child environment', async () => {
  const calls = await fakeGrok('success');
  const { configured, fake } = build();
  const judged = await configured.judges['prose']!.provider.generate({ prompt: 'judge', model: 'grok-4.6' });
  expect(judged).toMatchObject({ text: 'done', model: 'grok-4.6', route: 'grok-broker-grant', usage: { source: 'grok-broker-grant.result.usage.lower-bound' } });
  await configured.inference.generate({ prompt: 'reflect', model: 'grok-4.6' });
  expect(fake.requests).toEqual([{ model: 'grok-4.6', reasoningEffort: 'low', purpose: 'judge' }, { model: 'grok-4.6', reasoningEffort: 'medium', purpose: 'optimizer' }]);
  const recorded = await calls();
  expect(recorded.map(call => call.args[call.args.indexOf('--model') + 1])).toEqual(['daimon-inference-grok', 'daimon-inference-grok']);
  const env = recorded[0]!.env;
  expect(Object.keys(env).filter(key => !['PATH', 'HOME', 'TMPDIR', 'GROK_HOME', 'DAIMON_INFERENCE_GRANT'].includes(key) && !/^(__CF|SHLVL|_|PWD)/u.test(key))).toEqual([]);
  expect(env['GROK_HOME']!.startsWith(path.join(root, 'homes'))).toBe(true);
  expect(env['DAIMON_INFERENCE_GRANT']).toMatch(/^inference_/u);
  expect(Object.values(process.env).some(value => value?.startsWith('inference_'))).toBe(false);
});

it('fails a stale realm fast to the authored Claude fallback and fails closed without socket, home or Daimon', async () => {
  const calls = await fakeGrok('stale');
  const stale = build();
  const answer = await stale.configured.judges['prose']!.provider.generate({ prompt: 'judge', model: 'grok-4.6' });
  expect(answer.text).toBe('claude');
  expect(answer.attempts?.map(attempt => attempt.failureKind)).toEqual(['auth-stale', null]);
  expect(await calls()).toHaveLength(1);
  expect(stale.fake.releases).toHaveLength(1);

  delete process.env['PAIDEIA_GROK_BROKER_CONTROL_SOCKET'];
  const noSocket = build(fakeGrantAuthority(), true);
  await expect(noSocket.configured.inference.generate({ prompt: 'reflect', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  process.env['PAIDEIA_GROK_BROKER_CONTROL_SOCKET'] = path.join(root, 'absent.sock');
  const noDaimonSocket = build(fakeGrantAuthority(), true);
  await expect(noDaimonSocket.configured.judges['prose']!.provider.generate({ prompt: 'judge', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  expect(noDaimonSocket.claude()).toBe(0);
  process.env['PAIDEIA_GROK_GRANT_HOME_ROOT'] = '';
  const noHome = build();
  await expect(noHome.configured.inference.generate({ prompt: 'reflect', model: 'grok-4.6' })).rejects.toMatchObject({ kind: 'unsupported' });
  expect(noHome.fake.requests).toHaveLength(0);
  expect(await calls()).toHaveLength(1);
});
