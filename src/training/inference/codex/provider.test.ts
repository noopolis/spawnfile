import { mkdtemp, rm, writeFile, chmod, stat, readdir, readlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessOptions, ProcessResult, RunningProcess } from '../../platform/process/index.js';
import { createCodexInference, codexArguments, codexEnvironment } from './provider.js';

const request = { model: 'chosen', prompt: 'question' };
const frames = [
  { type: 'thread.started', thread_id: 't', model: 'reported' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'private' } },
  { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'early' } },
  { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: '{"q":"yes"}' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 } },
];
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true }))); });
function runner(events: unknown[] = frames, patch: Partial<ProcessResult> = {}, auth = 'Logged in using ChatGPT') {
  return (options: ProcessOptions): RunningProcess => ({
    write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => {
      if (options.args.includes('status')) return { exitCode: 0, stderr: auth, cancelled: false };
      try {
        for (const event of events) await options.onLine(typeof event === 'string' ? event : JSON.stringify(event), new AbortController().signal);
        return { exitCode: 0, stderr: '', cancelled: false, ...patch };
      } catch { return { exitCode: null, stderr: '', cancelled: true, error: 'callback rejected' }; }
    })(),
  });
}

it('uses an empty workspace, auth-only home, selected controls, final message and measured usage', async () => {
  const calls: ProcessOptions[] = [];
  const provider = createCodexInference({ authHome: '/selected-auth', reasoningEffort: 'high', process: options => {
    calls.push(options);
    const plumbing = runner([])( { ...options, onLine: () => undefined });
    return { ...plumbing, completion: (async () => {
      const schemaFile = path.join(options.cwd, 'response-schema.json');
      if (options.args.includes('status')) expect(await readdir(options.cwd)).toEqual([]);
      else {
        expect(options.args).toContain('--output-schema');
        expect(options.args[options.args.indexOf('--output-schema') + 1]).toBe(schemaFile);
        expect(await readdir(options.cwd)).toEqual(['response-schema.json']);
        expect(JSON.parse(await readFile(schemaFile, 'utf8'))).toEqual({ type: 'object' });
        expect((await stat(schemaFile)).mode & 0o777).toBe(0o600);
      }
      expect(await readdir(options.env['CODEX_HOME']!)).toEqual(['auth.json']);
      expect(await readlink(path.join(options.env['CODEX_HOME']!, 'auth.json'))).toBe('/selected-auth/auth.json');
      return runner()(options).completion;
    })() };
  } });
  expect(provider.capabilities.tools).toBe('contained');
  expect(await provider.generate({ ...request, system: 'judge', responseSchema: { type: 'object' } })).toMatchObject({
    text: '{"q":"yes"}', model: 'reported', modelBasis: 'provider-reported', usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, reasoningTokens: null },
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.args).toEqual(codexArguments({ ...request, system: 'judge' }, 'high', path.join(calls[1]!.cwd, 'response-schema.json')));
  for (const flag of ['--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json', 'read-only', 'memories',
    'approval_policy="never"', 'web_search="disabled"', 'mcp_servers={}', 'model_provider="openai"', 'forced_login_method="chatgpt"', 'model_reasoning_effort="high"']) {
    expect(calls[1]!.args).toContain(flag);
  }
  expect(calls[1]!.args.join(' ')).not.toMatch(/network_access|network.*true/);
  expect(codexArguments(request)).not.toContain('--output-schema');
  expect(calls[1]!.stdin).toBe('question');
  await expect(stat(calls[0]!.cwd)).rejects.toThrow();
  await expect(stat(calls[0]!.env['HOME']!)).rejects.toThrow();
});

it('strips every API key and ambient provider/config overrides', () => {
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OTHER_API_KEY', 'OPENAI_BASE_URL', 'CODEX_PROFILE', 'NODE_OPTIONS', 'HTTPS_PROXY']) vi.stubEnv(key, 'secret');
  const env = codexEnvironment('/clean');
  expect(Object.keys(env).filter(key => /API_KEY|BASE_URL|PROFILE|PROXY|NODE_OPTIONS/.test(key))).toEqual([]);
  expect(env['HOME']).toBe('/clean');
  expect(env['CODEX_HOME']).toBe('/clean/.codex');
});

it.each(['command_execution', 'file_change', 'web_search', 'mcp_tool_call', 'unknown_future_tool'])('refuses %s immediately without retry', async type => {
  const calls: ProcessOptions[] = [];
  await expect(createCodexInference({ process: options => { calls.push(options); return runner([
    ...frames.slice(0, 2), { type: 'item.started', item: { id: 'tool', type } }, ...frames.slice(2),
  ])(options); } }).generate(request)).rejects.toMatchObject({ kind: 'protocol', detail: 'tool-call' });
  expect(calls).toHaveLength(2);
  await expect(stat(calls[0]!.cwd)).rejects.toThrow();
});

it.each(['Logged in using an API key', 'Not logged in', 'Logged in using ChatGPT\nUnexpected account'])('rejects non-subscription/ambiguous preflight %s', async auth => {
  let calls = 0;
  await expect(createCodexInference({ process: options => { calls++; return runner([], {}, auth)(options); } }).generate(request))
    .rejects.toMatchObject({ kind: 'authentication' });
  expect(calls).toBe(1);
});

it('preserves tool-call refusal when the runner rejects with a replacement error', async () => {
  const replacement = new Error('runner replaced the callback error');
  let callbackFailure: unknown;
  const provider = createCodexInference({ process: options => {
    const running = runner([])(options);
    if (options.args.includes('status')) return running;
    return { ...running, completion: (async () => {
      try {
        await options.onLine(JSON.stringify({ type: 'item.started', item: { id: 'tool', type: 'command_execution' } }),
          new AbortController().signal);
      } catch (error) { callbackFailure = error; }
      throw replacement;
    })() };
  } });
  await expect(provider.generate(request)).rejects.toMatchObject({ kind: 'protocol', detail: 'tool-call' });
  expect(callbackFailure).toMatchObject({ kind: 'protocol', detail: 'tool-call' });
});

it.each(['agent_message', 'reasoning'])('accepts missing or empty text only on %s starts', async type => {
  for (const text of [undefined, '']) {
    const events = [...frames.slice(0, 2), { type: 'item.started', item: { id: 'start', type, text } }, ...frames.slice(2)];
    expect((await createCodexInference({ process: runner(events) }).generate(request)).text).toBe('{"q":"yes"}');
  }
  for (const eventType of ['item.updated', 'item.completed']) {
    const events = [...frames.slice(0, 2), { type: eventType, item: { id: 'start', type } }, ...frames.slice(2)];
    await expect(createCodexInference({ process: runner(events) }).generate(request)).rejects.toMatchObject({ kind: 'protocol' });
  }
  for (const text of [null, 42, {}]) {
    const events = [...frames.slice(0, 2), { type: 'item.started', item: { id: 'start', type, text } }, ...frames.slice(2)];
    await expect(createCodexInference({ process: runner(events) }).generate(request)).rejects.toMatchObject({ kind: 'protocol' });
  }
});

it.each([
  [], ['bad'], ['[]'], ['null'], [{}], [{ type: 'unknown' }], [frames[1]], [frames[0], frames[0]],
  [frames[0], frames[1], frames[1]], [...frames.slice(0, 2), { type: 'item.completed', item: { type: 'agent_message' } }],
  [...frames.slice(0, 2), { type: 'item.strange', item: { type: 'reasoning', id: 'a', text: '' } }],
  [...frames.slice(0, 2), frames[5]], [...frames, frames[5]], [...frames, frames[2]],
  [...frames.slice(0, 5), { type: 'turn.completed', usage: [] }],
  ['{"type":"thread.started","type":"turn.started"}'],
].map(events => ({ events })))('rejects malformed, incomplete or duplicated streams (%j)', async ({ events }) => {
  await expect(createCodexInference({ process: runner(events) }).generate(request)).rejects.toMatchObject({ kind: 'protocol' });
});

it.each([
  ['unauthorized 401', 'authentication'], ['usage limit exceeded', 'quota'], ['stream disconnected', 'transport'],
  ['unknown failure', 'protocol'], [undefined, 'protocol'],
])('classifies native failures without leaking prose (%s)', async (message, kind) => {
  for (const event of [{ type: 'error', message }, { type: 'turn.failed', error: { message } }]) {
    await expect(createCodexInference({ process: runner([event]) }).generate(request)).rejects.toMatchObject({ kind });
  }
});

it('preserves requested-model assumption, nullable counters and omitted usage', async () => {
  const events = [{ type: 'thread.started', thread_id: 't' }, ...frames.slice(1, 5), { type: 'turn.completed' }];
  expect(await createCodexInference({ process: runner(events) }).generate(request)).toMatchObject({ model: 'chosen', modelBasis: 'requested-assumption', usage: null });
  events[5] = { type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 1.5 } } as typeof events[number];
  expect((await createCodexInference({ process: runner(events) }).generate(request)).usage).toMatchObject({ inputTokens: null, outputTokens: null });
});

it('rejects invalid controls before launch and schema-invalid answers after completion', async () => {
  const process = vi.fn(() => { throw Error('must not launch'); });
  for (const patch of [{ prompt: '' }, { model: '' }, { model: '-x' }, { temperature: 0 }, { seed: 1 }]) {
    await expect(createCodexInference({ process }).generate({ ...request, ...patch })).rejects.toMatchObject({ kind: 'unsupported' });
  }
  await expect(createCodexInference({ process, reasoningEffort: 'bogus' }).generate(request)).rejects.toMatchObject({ kind: 'unsupported' });
  await expect(createCodexInference({ process }).generate({ ...request, signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'cancelled' });
  expect(process).not.toHaveBeenCalled();
  await expect(createCodexInference({ process: runner() }).generate({ ...request, responseSchema: { type: 'object', required: ['absent'] } })).rejects.toMatchObject({ kind: 'invalid-response', usage: { inputTokens: 10 } });
});

it('classifies native process interruption, nonzero exit and launch failure', async () => {
  for (const [patch, kind] of [
    [{ error: 'Native protocol ended without a line terminator' }, 'protocol'],
    [{ error: 'spawn failed' }, 'transport'], [{ cancelled: true }, 'transport'],
    [{ stop: { reason: 'timeout' } }, 'timeout'], [{ exitCode: 1, stderr: 'quota' }, 'quota'],
  ] as const) await expect(createCodexInference({ process: runner(frames, patch as Partial<ProcessResult>) }).generate(request)).rejects.toMatchObject({ kind });
  await expect(createCodexInference({ process: () => { throw Error('secret'); } }).generate(request)).rejects.toMatchObject({ kind: 'transport' });
  const controller = new AbortController();
  await expect(createCodexInference({ process: options => {
    if (!options.args.includes('status')) controller.abort();
    return runner()(options);
  } }).generate({ ...request, signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
});

it('runs an actual fake binary with stripped environment and deletes its workspace', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-codex-')); dirs.push(dir);
  const binary = path.join(dir, 'codex');
  await writeFile(binary, `#!${process.execPath}\nif (process.argv.includes('status')) { console.error('Logged in using ChatGPT'); } else {\nif (Object.keys(process.env).some(k => k.endsWith('_API_KEY')) || process.env.OPENAI_BASE_URL) process.exit(8);\n${frames.map(event => `console.log(${JSON.stringify(JSON.stringify(event))});`).join('\n')}\n}\n`);
  await chmod(binary, 0o700);
  vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-child'); vi.stubEnv('ALIEN_API_KEY', 'must-not-reach-child');
  expect(await createCodexInference({ command: binary, authHome: dir }).generate(request)).toMatchObject({ text: '{"q":"yes"}' });
});

it('accepts native login status on stdout and rejects unsuccessful auth status', async () => {
  for (const exitCode of [0, 1]) {
    const provider = createCodexInference({ process: options => {
      if (!options.args.includes('status')) return runner()(options);
      return { ...runner([])(options), completion: (async () => {
        await options.onLine('Logged in using ChatGPT', new AbortController().signal);
        return { exitCode, stderr: '', cancelled: false };
      })() };
    } });
    if (exitCode === 0) expect((await provider.generate(request)).text).toBe('{"q":"yes"}');
    else await expect(provider.generate(request)).rejects.toMatchObject({ kind: 'authentication' });
  }
});
