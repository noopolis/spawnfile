import { readFile, readdir, stat } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { TrainingConfiguration } from '../../contracts/index.js';
import { runProcess, type ProcessOptions } from '../../platform/process/index.js';
import { createCodexInference } from '../../inference/index.js';
import { createTrainingInference } from './inference.js';
import { createDspyGeneration } from '../../optimization/index.js';

vi.mock('../../platform/process/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../platform/process/index.js')>();
  return { ...actual, runProcess: vi.fn() };
});
vi.mock('../../inference/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../inference/index.js')>();
  return { ...actual, createCodexInference: vi.fn(actual.createCodexInference) };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const training: TrainingConfiguration = {
  models: { primary: { provider: 'codex-subscription', model: 'chosen' } },
  judges: { prose: { model: 'primary' } }, optimizer: { model: 'primary' },
};
const schema = { type: 'object', additionalProperties: false, required: ['answer'],
  properties: { answer: { type: 'string' }, note: { type: 'string' } } };

function nativeProcess(auth: string, text = '{"answer":"yes","note":null}') {
  vi.mocked(runProcess).mockImplementation(options => ({
    write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed',
      remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => {
      if (options.args.includes('status')) return { exitCode: 0, stderr: auth, cancelled: false };
      for (const frame of [
        { type: 'thread.started', thread_id: 'test' }, { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } },
        { type: 'turn.completed' },
      ]) await options.onLine(JSON.stringify(frame), new AbortController().signal);
      return { exitCode: 0, stderr: '', cancelled: false };
    })(),
  }));
}

function configured() {
  return createTrainingInference({ command: 'train', flags: {}, training }, {}, 1000,
    { prose: 'chosen' }, { prose: 0 });
}

it.each(['optimizer', 'judge'] as const)('dispatches %s to the actual subscription-only Codex strict schema path', async purpose => {
  nativeProcess('Logged in using ChatGPT');
  vi.stubEnv('OPENAI_API_KEY', 'forbidden-test-value');
  vi.stubEnv('CODEX_API_KEY', 'forbidden-test-value');
  const configuredRoutes = configured();
  expect(createCodexInference).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 1000 });
  const provider = purpose === 'optimizer' ? configuredRoutes.inference : configuredRoutes.judges.prose!.provider;
  expect(provider.capabilities).toMatchObject({ tools: 'contained', billing: 'subscription' });
  let execution: ProcessOptions | undefined;
  const native = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(options => {
    if (options.args.includes('status')) return native(options);
    execution = options;
    const running = native(options);
    return { ...running, completion: (async () => {
      const schemaFile = options.args[options.args.indexOf('--output-schema') + 1]!;
      expect(options.args).toContain('--output-schema');
      expect(JSON.parse(await readFile(schemaFile, 'utf8'))).toEqual({
        ...schema, required: ['answer', 'note'],
        properties: { answer: { type: 'string' }, note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      });
      expect((await stat(schemaFile)).mode & 0o777).toBe(0o600);
      expect(await readdir(options.env.CODEX_HOME!)).toEqual(['auth.json']);
      return running.completion;
    })() };
  });
  const result = purpose === 'optimizer'
    ? await createDspyGeneration(provider, 'ignored')({ purpose: 'reflection', messages: [
      { role: 'system', content: 'Optimize.' }, { role: 'user', content: 'Reflect.' },
    ], options: { responseSchema: schema } }, new AbortController().signal)
    : await provider.generate({ prompt: 'Reflect.', model: 'ignored', responseSchema: schema });
  expect(result).toMatchObject({ text: '{"answer":"yes"}', model: 'chosen', route: 'codex-subscription' });
  expect(runProcess).toHaveBeenCalledTimes(2);
  expect(vi.mocked(runProcess).mock.calls[0]![0].args).toEqual(['login', 'status']);
  expect(execution!.args).toEqual(expect.arrayContaining(['forced_login_method="chatgpt"', 'model_provider="openai"', '--model', 'chosen']));
  expect(execution!.stdin).toBe('Reflect.');
  expect(execution!.timeoutMs).toBe(1000);
  expect(Object.keys(execution!.env).filter(key => key.endsWith('_API_KEY'))).toEqual([]);
  await expect(stat(execution!.cwd)).rejects.toThrow();
  await configuredRoutes.close();
});

it('refuses API-key authentication through the training route before generation', async () => {
  nativeProcess('Logged in using an API key');
  await expect(configured().inference.generate({ prompt: 'Reflect.', model: 'ignored', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'authentication' });
  expect(runProcess).toHaveBeenCalledOnce();
});

it('keeps strict schema admission and completed response validation through the training route', async () => {
  nativeProcess('Logged in using ChatGPT', '{"answer":1,"note":null}');
  const { inference } = configured();
  await expect(inference.generate({ prompt: 'Reflect.', model: 'ignored', responseSchema: { type: 'object' } }))
    .rejects.toMatchObject({ kind: 'unsupported' });
  expect(runProcess).not.toHaveBeenCalled();
  await expect(inference.generate({ prompt: 'Reflect.', model: 'ignored', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'invalid-response' });
  expect(runProcess).toHaveBeenCalledTimes(2);
});
