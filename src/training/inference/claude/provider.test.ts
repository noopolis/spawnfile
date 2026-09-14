import { expect, it } from 'vitest';
import type { ProcessOptions, RunningProcess } from '../../platform/process/index.js';
import { claudeArguments, createClaudeInference } from './provider.js';

const auth = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}';
const result = { type: 'result', subtype: 'success', result: 'real output' };
function runner(lines: string[], patch: Partial<Awaited<RunningProcess['completion']>> = {}) {
  return (options: ProcessOptions): RunningProcess => ({
    write: async () => undefined, endInput: () => undefined,
    completion: (async () => { try {
      for (const line of options.args.includes('status') ? [auth] : lines) await options.onLine(line, new AbortController().signal);
      return { exitCode: 0, stderr: '', cancelled: false, ...patch };
    } catch (error) { return { exitCode: null, stderr: '', cancelled: true, error: String(error) }; } })(),
    stop: async (reason) => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
  });
}

it('performs native auth preflight and a tool-free generation in a disposable directory', async () => {
  const calls: ProcessOptions[] = [];
  const provider = createClaudeInference({ process: (options) => {
    calls.push(options); return runner([JSON.stringify({ type: 'system', subtype: 'init', tools: [], model: 'actual-model' }), JSON.stringify(result)])(options);
  } });
  const response = await provider.generate({ model: 'selected', prompt: 'task', system: 'instructions' });
  expect(response).toMatchObject({ text: 'real output', model: 'actual-model', modelBasis: 'provider-reported', route: 'claude-subscription', usage: null });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.args).toContain('--safe-mode');
  expect(calls[1]?.args.slice(calls[1]!.args.indexOf('--tools'), calls[1]!.args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
  expect(calls[1]?.args).toContain('--system-prompt');
  const { stat } = await import('node:fs/promises');
  await expect(stat(calls[0]!.cwd)).rejects.toThrow();
});

it('rejects unsupported controls before native work', async () => {
  const provider = createClaudeInference({ process: () => { throw new Error('must not launch'); } });
  for (const request of [{ model: 'm', prompt: 'p', seed: 1 }, { model: 'm', prompt: 'p', temperature: 0 },
    { model: 'm', prompt: '' }, { model: '--model', prompt: 'p' }, { model: '', prompt: 'p' },
    { model: 'm', prompt: 'p', signal: AbortSignal.abort() }]) await expect(provider.generate(request)).rejects.not.toThrow('must not launch');
  expect(claudeArguments({ model: 'm', prompt: 'p' })).not.toContain('--system-prompt');
});

it('rejects unavailable authentication without retaining account details', async () => {
  const provider = createClaudeInference({ process: (options) => ({
    ...runner([])(options), completion: Promise.resolve({ exitCode: 1, stderr: 'private account detail', cancelled: false }),
  }) });
  await expect(provider.generate({ model: 'm', prompt: 'p' })).rejects.toThrow('Saved Claude subscription');
});

it('fails closed on missing result, tool isolation failure and native unsuccessful envelopes', async () => {
  for (const lines of [[], ['{"type":"system","subtype":"init","tools":["Bash"]}'],
    ['{"type":"system","subtype":"init"}'], ['{"type":"result","subtype":"error","result":"bad"}']]) {
    await expect(createClaudeInference({ process: runner(lines) }).generate({ model: 'm', prompt: 'p' })).rejects.toThrow();
  }
  await expect(createClaudeInference({ process: runner([JSON.stringify(result)]) }).generate({ model: 'm', prompt: 'p' })).rejects.toThrow('isolation acknowledgement');
  const plain = await createClaudeInference({ process: runner(['{"type":"system","subtype":"init","tools":[]}', JSON.stringify(result)]) }).generate({ model: 'm', prompt: 'p' });
  expect(plain.model).toBe('m');
  expect(plain.modelBasis).toBe('requested-assumption');
});

it.each([undefined, '', '   '])('never labels an unreported model as provider-reported (%j)', async model => {
  const nativeUsage = { input_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 4 };
  const lines = [JSON.stringify({ type: 'system', subtype: 'init', tools: [], model }),
    JSON.stringify({ ...result, model, usage: nativeUsage })];
  const response = await createClaudeInference({ process: runner(lines) }).generate({ model: 'claude-fable-5-1', prompt: 'task' });
  expect(response).toMatchObject({ model: 'claude-fable-5-1', modelBasis: 'requested-assumption',
    usage: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 4 } });
});

it('prefers a reported terminal model over the initialization model', async () => {
  const lines = [JSON.stringify({ type: 'system', subtype: 'init', tools: [], model: 'initial' }),
    JSON.stringify({ ...result, model: 'terminal' })];
  const response = await createClaudeInference({ process: runner(lines) }).generate({ model: 'requested', prompt: 'task' });
  expect(response).toMatchObject({ model: 'terminal', modelBasis: 'provider-reported' });
});

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const schemaUsage = { input_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 4 };
const ready = JSON.stringify({ type: 'system', subtype: 'init', tools: [], model: 'native-model' });
it('requests native JSON schema and reads the structured terminal field without using conversational text', async () => {
  const calls: ProcessOptions[] = [];
  const structured = { answer: 'first\nsecond "quoted"' };
  const provider = createClaudeInference({ process: options => { calls.push(options); return runner([ready,
    JSON.stringify({ ...result, result: 'I will return the answer.', structured_output: structured, usage: schemaUsage })])(options); } });
  const response = await provider.generate({ model: 'm', prompt: 'p', responseSchema: schema });
  expect(JSON.parse(response.text)).toEqual(structured);
  expect(response).toMatchObject({ model: 'native-model', usage: { inputTokens: 5, outputTokens: 4 } });
  const args = calls[1]!.args, index = args.indexOf('--json-schema');
  expect(index).toBeGreaterThan(-1); expect(JSON.parse(args[index + 1]!)).toEqual(schema);
  expect(args).toContain('--restricted'); expect(args).toContain('--strict-mcp-config');
  expect(claudeArguments({ model: 'm', prompt: 'p' })).not.toContain('--json-schema');
});
it('rejects invalid schemas before even checking authentication', async () => {
  const provider = createClaudeInference({ process: () => { throw Error('must not launch'); } });
  for (const responseSchema of [{ type: 'invalid' }, { type: 'object', unknownKeyword: true }]) {
    await expect(provider.generate({ model: 'm', prompt: 'p', responseSchema })).rejects.toMatchObject({ kind: 'unsupported' });
  }
});
it.each([undefined, null, {}, { answer: 7 }, { answer: 'ok', unknown: 'not allowed' }])('rejects missing or mismatched structured output and preserves measured usage (%j)', async structured_output => {
  const provider = createClaudeInference({ process: runner([ready, JSON.stringify({ ...result,
    result: '{"answer":"must not substitute"}', structured_output, model: 'terminal-model', usage: schemaUsage })]) });
  await expect(provider.generate({ model: 'm', prompt: 'p', responseSchema: schema })).rejects.toMatchObject({ kind: 'protocol',
    responseModel: 'terminal-model', responseRoute: 'claude-subscription', usage: { inputTokens: 5, outputTokens: 4 } });
});
it('keeps a schema snapshot across asynchronous authentication and refuses unsupported native controls explicitly', async () => {
  const mutable = structuredClone(schema); const calls: ProcessOptions[] = [];
  const provider = createClaudeInference({ process: options => {
    calls.push(options); if (options.args.includes('status')) mutable.properties.answer.type = 'number';
    return runner([ready, JSON.stringify({ ...result, structured_output: { answer: 'text' }, usage: schemaUsage })])(options);
  } });
  expect((await provider.generate({ model: 'm', prompt: 'p', responseSchema: mutable })).text).toBe('{"answer":"text"}');
  expect(calls[1]!.args[calls[1]!.args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(schema));
  const rejected = createClaudeInference({ process: options => options.args.includes('status') ? runner([])(options) :
    runner([ready, JSON.stringify({ ...result, usage: schemaUsage })], { exitCode: 2 })(options) });
  await expect(rejected.generate({ model: 'm', prompt: 'p', responseSchema: schema })).rejects.toMatchObject({ kind: 'unsupported', usage: { inputTokens: 5 } });
});

it('rejects duplicate keys in the actual native structured field before serialization erases them', async () => {
  const envelope = JSON.stringify({ ...result, structured_output: { answer: 'x' }, usage: schemaUsage })
    .replace('"answer":"x"', '"answer":"x","answer":"y"');
  await expect(createClaudeInference({ process: runner([ready, envelope]) }).generate({ model: 'm', prompt: 'p', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'protocol', usage: { inputTokens: 5, outputTokens: 4 } });
});
