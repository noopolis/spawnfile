import { expect, it } from 'vitest';
import { runProcess, type ProcessOptions, type ProcessResult, type RunningProcess } from '../../platform/process/index.js';
import { createGrokInference, type GrokInferenceOptions } from './provider.js';
import { decodeGrok, grokEnvironment, type GrokFrames } from './protocol.js';
const frames = (): GrokFrames => ({
  init: { type: 'system', subtype: 'init', apiKeySource: 'oauth', tools: [], mcp_servers: [], model: 'grok-actual' },
  assistant: { type: 'assistant', session_id: 's', message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'answer' }] } },
  result: { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 's', result: 'answer', usage: { input_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 4 } },
});
function runner(events: unknown[], patch: Partial<Awaited<RunningProcess['completion']>> = {}) {
  return (options: ProcessOptions): RunningProcess => ({ write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => { try {
      for (const event of events) await options.onLine(JSON.stringify(event), new AbortController().signal);
      return { exitCode: 0, stderr: '', cancelled: false, ...patch };
    } catch { return { exitCode: 1, stderr: '', cancelled: true }; } })(),
  });
}
it('runs tool-free OAuth in a disposable workspace and decodes lower-bound usage', async () => {
  let call: ProcessOptions | undefined;
  const result = await createGrokInference({ process: options => { call = options; return runner(Object.values(frames()))(options); } }).generate({ prompt: 'p', system: 's', model: 'requested' });
  expect(result).toMatchObject({ text: 'answer', model: 'grok-actual', usage: { inputTokens: 6, cachedInputTokens: 2, outputTokens: 4 } });
  expect(call?.args).toContain('--no-memory'); expect(call?.args).toContain('--system-prompt-override');
  expect(call?.args.slice(call.args.indexOf('--tools'), call.args.indexOf('--permission-mode')))
    .toEqual(['--tools', 'read_file', '--disallowed-tools', 'read_file,search_tool,use_tool', '--deny', '*']);
  expect(call?.args).toContain('--verbatim');
  expect(call?.args[call.args.indexOf('--reasoning-effort') + 1]).toBe('medium');
  const { stat } = await import('node:fs/promises'); await expect(stat(call!.cwd)).rejects.toThrow();
});
it.each(['low', 'medium', 'high', 'xhigh'] as const)('forwards explicit %s reasoning effort', async reasoningEffort => {
  let call: ProcessOptions | undefined;
  await createGrokInference({ reasoningEffort, process: options => {
    call = options;
    return runner(Object.values(frames()))(options);
  } }).generate({ prompt: 'p', model: 'm' });
  expect(call?.args.filter(argument => argument === '--reasoning-effort')).toHaveLength(1);
  expect(call?.args[call.args.indexOf('--reasoning-effort') + 1]).toBe(reasoningEffort);
});
it.each(['', 'max', 'LOW', '--help', null, 1, {}])('rejects invalid reasoning effort %j before launching', async value => {
  let launches = 0;
  const provider = createGrokInference({ reasoningEffort: value as GrokInferenceOptions['reasoningEffort'], process: options => {
    launches++;
    return runner(Object.values(frames()))(options);
  } });
  await expect(provider.generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'unsupported' });
  expect(launches).toBe(0);
});
it('stops native failures and rejects unsupported requests before execution', async () => {
  const provider = createGrokInference({ process: runner([]) });
  for (const patch of [{ prompt: '' }, { model: '' }, { model: '-x' }, { seed: 1 }, { temperature: 0 }]) await expect(provider.generate({ prompt: 'p', model: 'm', ...patch })).rejects.toMatchObject({ kind: 'unsupported' });
  await expect(provider.generate({ prompt: 'p', model: 'm', signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'cancelled' });
  for (const patch of [{ cancelled: true }, { error: 'x' }]) await expect(createGrokInference({ process: runner([], patch) }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'unknown' });
  await expect(createGrokInference({ process: runner([...Object.values(frames()), {}]) }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
});
it.each([[429, 'quota'], [503, 'unavailable'], [401, 'authentication'], [403, 'authentication']])('classifies explicit refusal %s', (status, kind) => {
  expect(() => decodeGrok({ result: { status } }, 1)).toThrow(expect.objectContaining({ kind }));
});
it('rejects missing auth, isolation, terminal mismatch and arbitrary tool content', () => {
  expect(() => decodeGrok({}, 0)).toThrow(expect.objectContaining({ kind: 'protocol' }));
  for (const patch of [{ tools: ['read'] }, { tools: undefined }, { mcp_servers: [{}] }, { mcp_servers: {} }, { mcp_servers: undefined }]) {
    const value = frames(); Object.assign(value.init!, patch); expect(() => decodeGrok(value, 0)).toThrow('isolation');
  }
  for (const mutate of [
    (v: GrokFrames) => { v.init!['model'] = ''; },
    (v: GrokFrames) => { v.result!['result'] = ''; },
    (v: GrokFrames) => { v.result!['errors'] = ['x']; },
    (v: GrokFrames) => { v.result!['subtype'] = 'error'; },
    (v: GrokFrames) => { v.result!['is_error'] = true; },
    (v: GrokFrames) => { v.result!['stop_reason'] = 'max_tokens'; },
    (v: GrokFrames) => { v.assistant!['session_id'] = 'other'; },
    (v: GrokFrames) => { v.assistant!['message'] = { content: [{ type: 'tool_use' }], stop_reason: 'end_turn' }; },
    (v: GrokFrames) => { delete v.assistant; },
  ]) { const value = frames(); mutate(value); expect(() => decodeGrok(value, 0)).toThrow('matching completed'); }
  expect(() => decodeGrok(frames(), 1)).toThrow('matching completed');
});

it('retains attributable metadata when a completed native envelope fails isolation', () => {
  const value = frames(); value.init!['tools'] = ['search_tool', 'use_tool'];
  expect(() => decodeGrok(value, 0)).toThrow(expect.objectContaining({ kind: 'protocol',
    responseModel: 'grok-actual', responseRoute: 'grok-subscription',
    usage: expect.objectContaining({ inputTokens: 6, cachedInputTokens: 2, outputTokens: 4 }) }));
});

it('stops at unsafe initialization before another native frame is consumed', async () => {
  const value = frames(); value.init!['tools'] = ['read_file'];
  let delivered = 0;
  const process = (options: ProcessOptions) => runner(Object.values(value))({ ...options,
    onLine(line, signal) { delivered++; return options.onLine(line, signal); } });
  await expect(createGrokInference({ process }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({
    kind: 'protocol', responseModel: 'grok-actual', responseRoute: 'grok-subscription', usage: null });
  expect(delivered).toBe(1);
});

it('stops on assistant output before init while retaining typed pre-init refusals', async () => {
  let delivered = 0;
  const value = frames();
  const process = (options: ProcessOptions) => runner([value.assistant, value.init, value.result])({ ...options,
    onLine(line, signal) { delivered++; return options.onLine(line, signal); } });
  await expect(createGrokInference({ process }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
  expect(delivered).toBe(1);
  await expect(createGrokInference({ process: runner([{ type: 'error', status: 429 }]) })
    .generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'quota' });
});

it('terminates the actual owned process when initialization exposes tools', async () => {
  const init = { ...frames().init, tools: ['read_file'] };
  const script = `process.stdout.write(${JSON.stringify(JSON.stringify(init) + '\n')});setInterval(()=>{},10000);`;
  let completed: ProcessResult | undefined;
  const provider = createGrokInference({ timeoutMs: 5000, process(options) {
    const child = runProcess({ ...options, command: process.execPath, args: ['-e', script] });
    return { ...child, completion: child.completion.then(result => { completed = result; return result; }) };
  } });
  await expect(provider.generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
  expect(completed).toMatchObject({ cancelled: true,
    stop: { state: 'acknowledged', quiescence: 'confirmed', reason: 'observation or output failure' } });
});

it('passes large prompt and system text verbatim through the disposable files and arguments', async () => {
  const prompt = 'PREFACE\n' + 'evidence '.repeat(1800) + '\nEXACT-TAIL';
  const system = 'Judge this supplied text only.';
  const { readFile } = await import('node:fs/promises');
  let actual = '';
  const result = await createGrokInference({ process(options) {
    return { ...runner([])(options), completion: (async () => {
      actual = await readFile(options.args[options.args.indexOf('--prompt-file') + 1]!, 'utf8');
      expect(options.args[options.args.indexOf('--system-prompt-override') + 1]).toBe(system);
      return runner(Object.values(frames()))(options).completion;
    })() };
  } }).generate({ prompt, system, model: 'm' });
  expect(result.text).toBe('answer'); expect(actual).toBe(prompt);
});
it('retains unknown counts and strips ambient API credentials', () => {
  const value = frames(); value.result!['usage'] = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  expect(decodeGrok(value, 0).usage).toBeNull();
  delete value.result!['usage']; expect(decodeGrok(value, 0).usage?.inputTokens).toBeNull();
  process.env['XAI_API_KEY'] = 'secret';
  try { expect(grokEnvironment()['XAI_API_KEY']).toBeUndefined(); } finally { delete process.env['XAI_API_KEY']; }
});
it('classifies the captured Grok balance-exhausted wrapper without parsing model prose', () => {
  const value = frames();
  value.result = { type: 'result', is_error: true, errors: ['Internal error: {"http_status":402,"message":"private"}'] };
  expect(() => decodeGrok(value, 1)).toThrow(expect.objectContaining({ kind: 'quota' }));
  for (const errors of [['Internal error: broken'], ['ordinary text'], [null], ['Internal error: {}'], []]) {
    value.result = { type: 'result', is_error: true, errors };
    expect(() => decodeGrok(value, 1)).toThrow(expect.objectContaining({ kind: 'protocol' }));
  }
});
it('classifies malformed message blocks as protocol failures', () => {
  for (const content of [[null], [{ type: 'text', text: 12 }], [{ type: 'tool_use' }], ['bad']]) {
    const value = frames(); value.assistant!['message'] = { content, stop_reason: 'end_turn' };
    expect(() => decodeGrok(value, 0)).toThrow(expect.objectContaining({ kind: 'protocol' }));
  }
});

it('requires explicit OAuth and rejects non-object native frames', async () => {
  const value = frames(); value.init!['apiKeySource'] = 'api';
  expect(() => decodeGrok(value, 0)).toThrow(expect.objectContaining({ kind: 'authentication' }));
  for (const event of [null, [], 'invalid']) await expect(createGrokInference({ process: runner([event]) })
    .generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
});
