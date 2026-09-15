import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { authoredArguments } from './configuration.js';
import { parseArguments } from '../arguments.js';
import { cliFixture, datasetText } from '../fixture.js';
import { main } from '../commands.js';
import { prepareCliInputs } from '../native.js';
import { createTrainingInference, configuredCostRoutes } from './inference.js';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { openExperimentStore } from '../../storage/index.js';
import { InferenceFailure } from '../../inference/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const configuration: TrainingConfiguration = {
  models: { small: { provider: 'ollama', model: 'small', endpoint: 'http://127.0.0.1:11434' },
    backup: { provider: 'grok-subscription', model: 'grok' }, large: { provider: 'claude-subscription', model: 'opus' } },
  judges: { prose: { model: 'small', fallbacks: ['backup'], attempts: 2, template: { language: 'jinja', text: '{{ rubric }}' }, citation_repairs: 1 } },
  optimizer: { model: 'large', fallbacks: ['backup'] }, budget: { max_trials: 8, max_proposals: 2, timeout_ms: 600000 },
  cache: { mode: 'exact' }, test: 'test.yaml', validation_groups: ['b'], seed: 7,
};
async function fixture(config: TrainingConfiguration = configuration) {
  const f = await cliFixture(); roots.push(f.root);
  await mkdir(join(f.root, 'evals'));
  await writeFile(join(f.root, 'evals/train.yaml'), `${datasetText([{ id: 'a', group: 'a' }, { id: 'b', group: 'b' }])}\ntraining: ${JSON.stringify(config)}\n`);
  await writeFile(join(f.root, 'evals/test.yaml'), datasetText([{ id: 'x', group: 'x' }]).replace('id: example', 'id: sealed'));
  const args = ['train', '--train', 'evals/train.yaml', '--runtime', 'codex', '--model', 'gpt-5.5', '--instructions', 'AGENTS.md', '--editable', 'AGENTS.md', '--dry-run'];
  return { ...f, args };
}
it('resolves dataset-relative test and YAML budgets before starting and permits scalar overrides', async () => {
  const f = await fixture();
  const args = authoredArguments(parseArguments(f.args), f.io);
  expect(args.flags).toMatchObject({ test: [join(f.root, 'evals/test.yaml')], 'timeout-ms': ['600000'], 'max-trials': ['8'],
    'max-proposals': ['2'], seed: ['7'], 'optimizer-model': ['opus'], 'bridge-command': ['paideia-dspy'], judge: ['prose=small'], 'judge-citation-repairs': ['prose=1'] });
  expect(authoredArguments(parseArguments([...f.args, '--max-trials', '9']), f.io).flags['max-trials']).toEqual(['9']);
  const forbidden = vi.fn(() => { throw new Error('Models must remain unopened'); });
  expect(await main(f.args, f.io, { adapter: forbidden, inference: forbidden, modelInference: forbidden })).toBe(0);
  expect(forbidden).not.toHaveBeenCalled();
  expect(JSON.parse(f.stdout[0]!).budget.maxTrials).toBe(8);
});
it('rejects policy overrides rather than silently changing configured evaluation identity', async () => {
  const f = await fixture();
  for (const flags of [['--judge', 'prose=other'], ['--optimizer-model', 'other'], ['--judge', 'prose=small', '--judge-citation-repairs', 'prose=0']]) {
    expect(() => authoredArguments(parseArguments([...f.args, ...flags]), f.io)).toThrow(/conflict/);
  }
});
it('preserves legacy commands, named legacy judges and omitted optional config', async () => {
  const f = await fixture({ models: configuration.models });
  expect(authoredArguments(parseArguments(['help']), f.io).command).toBe('help');
  expect(authoredArguments(parseArguments(['validate', 'data.yaml']), f.io).training).toBeUndefined();
  const args = authoredArguments(parseArguments([...f.args, '--judge', 'extra=legacy']), f.io);
  expect(args.flags.judge).toEqual(['extra=legacy']);
  expect(args.flags.test).toBeUndefined();
  expect(configuredCostRoutes(args, { extra: 'legacy' }, { extra: 0 }).optimizerRoute).toBeUndefined();
});
it('uses named provider factories, routes quota fallback and keeps a valid negative grade', async () => {
  const f = await fixture();
  const args = authoredArguments(parseArguments(f.args), f.io);
  const calls: string[] = [];
  const modelInference = vi.fn(model => ({ id: model.provider, capabilities: { tools: 'disabled' as const, billing: 'subscription' as const, seed: false, temperature: false },
    async generate() { calls.push(model.model); if (model.model === 'small') throw new InferenceFailure('quota', 'full');
      return { text: '{"score":0}', model: model.model, route: model.provider, usage: null }; } }));
  const native = createTrainingInference(args, { modelInference }, 900000, { prose: 'small' }, { prose: 1 });
  expect(await native.judges.prose!.provider.generate({ model: 'small', prompt: 'grade' })).toMatchObject({ text: '{"score":0}', model: 'grok' });
  expect(calls).toEqual(['small', 'grok']);
  expect(native.judges.prose!.cache).toBeDefined();
  expect(native.judges.prose!.template).toEqual(configuration.judges!.prose!.template);
  expect(modelInference).toHaveBeenCalledTimes(3);
  expect(configuredCostRoutes(args, { prose: 'small' }, { prose: 1 })).toMatchObject({ judges: { prose: { provider: 'ollama', fallbacks: [{ model: 'grok' }], attempts: 2 } } });
});
it('constructs provider adapters without generating and supports legacy dependency injection', async () => {
  const f = await fixture();
  const args = authoredArguments(parseArguments(f.args), f.io);
  expect(createTrainingInference(args, {}, 1000, { prose: 'small' }, { prose: 1 }).inference.id).toMatch(/optimizer/);
  const legacy = { id: 'legacy', capabilities: { tools: 'disabled' as const, billing: 'subscription' as const, seed: false, temperature: false }, generate: vi.fn() };
  const inference = vi.fn(() => legacy);
  expect(createTrainingInference({ command: 'evaluate', flags: {} }, { inference }, 1000, { old: 'model' }, { old: 0 }).judges.old!.provider).toBe(legacy);
  expect(inference).toHaveBeenCalledOnce();
  expect(createTrainingInference({ command: 'evaluate', flags: {} }, {}, 1000, {}, {}).inference.id).toBe('claude-subscription');
});
it('covers sparse authored controls, default local endpoint and repeated named provider instances', async () => {
  const config: TrainingConfiguration = { models: { local: { provider: 'ollama', model: 'small' } },
    judges: { a: { model: 'local' }, b: { model: 'local' } }, optimizer: { model: 'local' }, cache: { mode: 'off' } };
  const f = await fixture(config);
  const args = authoredArguments(parseArguments(f.args), f.io);
  const native = createTrainingInference(args, {}, 1000, { a: 'small', b: 'small' }, { a: 0, b: 0 });
  expect(native.judges.a!.cache).toBeUndefined();
  expect(native.judges.b!.provider.id).toContain('authored-judge');
  expect(configuredCostRoutes(args, { a: 'small' }, { a: 0 }).judges.a).toMatchObject({ attempts: 1, fallbacks: [] });
  expect(authoredArguments(parseArguments(['validate', 'evals/train.yaml']), f.io).training).toEqual(config);
  const direct = parseArguments(f.args);
  expect(() => authoredArguments({ ...direct, flags: { ...direct.flags, 'judge-citation-repairs': ['a=1'] } }, f.io)).toThrow('citation repair policy conflicts');
});
it('runs an actual stored CLI evaluation using YAML judge fallbacks and template', async () => {
  const f = await fixture();
  const check = { id: 'prose', eval: 'llm-rubric', judge: 'prose', input: 'output.text', minimum: 0.8, rubric: { prompt: 'Clear prose.' } };
  await writeFile(join(f.root, 'evaluation.yaml'), JSON.stringify({ schema: 'paideia.dataset.v1', id: 'authored', training: configuration,
    checks: [check], records: [{ id: 'a', input: { prompt: 'Write.' } }] }));
  const attempted: string[] = [];
  const code = await main(['evaluate', 'evaluation.yaml', ...f.nativeArgs], f.io, { ...f.dependencies,
    modelInference: model => ({ id: model.provider, capabilities: { tools: 'disabled', billing: 'subscription', seed: false, temperature: false },
      async generate(request) {
        attempted.push(model.model);
        if (model.model === 'small') throw new InferenceFailure('unavailable', 'offline');
        expect(request.prompt).toContain('Clear prose.');
        return { text: JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Clear.'], citations: [{ source: 'input', quote: 'BAD' }] }),
          model: model.model, route: model.provider, usage: null };
      } }),
  });
  expect(f.stderr).toEqual([]);
  expect(code).toBe(0);
  expect(attempted).toEqual(['small', 'grok']);
  expect(JSON.parse(f.stdout.at(-1)!).status).toBe('completed');
});
it('autonomously completes real DSPy training from authored YAML with the installed default bridge', async () => {
  const f = await fixture({ models: { reflection: { provider: 'claude-subscription', model: 'reflection' } },
    optimizer: { model: 'reflection' }, budget: { max_trials: 6, max_proposals: 1, timeout_ms: 15000 },
    validation_groups: ['b'], test: 'test.yaml', seed: 0 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dirname(f.bridge)}:${originalPath ?? ''}`;
  try {
    const code = await main([...f.args.filter(value => value !== '--dry-run'), '--out', 'out'], f.io,
      { ...f.dependencies, modelInference: () => f.dependencies.inference!(15000) });
    expect(f.stderr).toEqual([]);
    expect(code).toBe(0);
    const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
    const store = await openExperimentStore(join(f.root, 'out'));
    const report = JSON.parse((await store.readBlob(index.report, { audience: 'evaluator', phase: 'test', frozenCandidateIds: [index.candidateId] })).toString());
    expect(report.optimizer.provenance).toMatchObject({ optimizer: 'dspy.GEPA', evaluations: 4, proposals: 1 });
    expect(report.heldOut.map((entry: { meanScore: number }) => entry.meanScore)).toEqual([0, 1]);
    expect(report.trials).toHaveLength(6);
    expect(report.selected.resources[0].content).toContain('IMPROVED');
  } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
});

it.each([true, false])('rejects changed dataset bytes after configuration selection (authored=%s)', async authored => {
  const f = await fixture();
  const argv = authored ? f.args : ['evaluate', 'data.yaml', ...f.nativeArgs];
  const args = authoredArguments(parseArguments(argv), f.io);
  const selected = await prepareCliInputs(args, f.io, f.dependencies);
  const file = authored ? 'evals/train.yaml' : 'data.yaml';
  await writeFile(join(f.root, file), `${await readFile(join(f.root, file), 'utf8')}\n# Concurrent edit\n`);
  expect(() => selected.datasets.load(file, authored)).toThrow('Dataset changed');
  expect(f.observedInstructions).toEqual([]);
});

it('maps authored fast-judge controls through the actual YAML factory without extra calls', async () => {
  const config: TrainingConfiguration = { models: { small: { provider: 'ollama', model: 'qwen3:4b', endpoint: 'http://localhost:11434',
    think: false, keep_alive_seconds: 300, max_output_tokens: 256, context_window: 8192 } },
  judges: { narrow: { model: 'small', protocol: 'evidence-ids', timeout_ms: 10000 } } };
  const f = await fixture(config), args = authoredArguments(parseArguments(f.args), f.io);
  const fetch = vi.fn<typeof globalThis.fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/version') ? { version: '0.34.0' } : { done: true, model: 'qwen3:4b', message: { content: 'ok' } })));
  vi.stubGlobal('fetch', fetch);
  try {
    const routes = createTrainingInference(args, {}, 120000, { narrow: 'small' }, { narrow: 0 });
    expect(routes.judges.narrow!.protocol).toBe('evidence-ids');
    await routes.judges.narrow!.provider.generate({ model: 'small', prompt: 'p' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toMatchObject({ think: false, keep_alive: '300s', truncate: false, shift: false, options: { num_predict: 256, num_ctx: 8192 } });
  } finally { vi.unstubAllGlobals(); }
});

it('does not construct an optimizer route for comparison and rejects requesting one', () => {
  const config = { models: { unused: { provider: 'grok-subscription' as const, model: 'unused' } },
    comparison: { candidate: { name: 'fixed', replacements: [{ resource: 'AGENTS.md', source: 'variant.md' }] } } };
  const inference = createTrainingInference({ command: 'train', flags: {}, training: config }, {
    inference: () => { throw new Error('unexpected legacy provider'); },
    modelInference: () => { throw new Error('unexpected model provider'); },
  }, 1000, {}, {});
  expect(inference.judges).toEqual({});
  expect(() => inference.inference).toThrow('no optimizer');
});
