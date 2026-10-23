import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cliFixture, fixtureAdapter } from '../../fixtures/support/training/cli-fixture.js';
import { main, launch } from './trainingCli.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['main', 'launch'] as const)('composes capped TypeSafe training through %s without losing runtime providers', async entry => {
  const f = await cliFixture(); roots.push(f.root);
  const model = 'jev-1.13.0', receiptPath = join(f.root, 'receipts.jsonl');
  const policy = join(f.root, 'evaluator.json');
  await writeFile(policy, JSON.stringify({ version: 'spawnfile.training.evaluator-routes.v1', receiptPath, routes: [
    { purpose: 'decisions', provider: 'typesafe', model, maxRequests: 6, maxSpendUsd: 1 },
    { purpose: 'extraction', provider: 'codex-subscription', model: 'codex-test', maxRequests: 1 },
  ] }));
  vi.stubEnv('SPAWNFILE_TRAINING_MODEL_REQUEST_CAP', 'broker');
  vi.stubEnv('SPAWNFILE_TRAINING_EVALUATOR_ROUTES_FILE', policy);
  vi.stubEnv('TYPESAFE_API_KEY', 'FAKE_TEST_KEY');
  await writeFile(join(f.root, 'grader.yaml'), JSON.stringify({ schema: 'spawnfile.training.grader.v1', id: 'fixed',
    calibration: 'identity', model: { backend: 'typesafe', name: model }, max_spend_usd: 1,
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }], score: { method: 'weighted' } }));
  const dataset = (id: string, records: { id: string; group: string }[]) => ({ schema: 'spawnfile.training.dataset.v1', id,
    checks: [{ id: 'quality', eval: 'grader', grader: 'grader.yaml', input: 'artifact:report' }],
    records: records.map(record => ({ ...record, input: { prompt: 'Write report.' }, outputs: { report: 'report.json' } })) });
  await writeFile(join(f.root, 'variant.md'), 'IMPROVED\n');
  await writeFile(join(f.root, 'train.yaml'), JSON.stringify({ ...dataset('train', [{ id: 'train', group: 'a' }, { id: 'validation', group: 'b' }]),
    training: { models: { extractor: { provider: 'codex-subscription', model: 'codex-test' } },
      comparison: { candidate: { name: 'Variant', replacements: [{ resource: 'AGENTS.md', source: 'variant.md' }] } },
      budget: { max_trials: 6, timeout_ms: 20000 }, validation_groups: ['b'], test: 'test.yaml' } }));
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify(dataset('test', [{ id: 'sealed', group: 'sealed' }])));
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { questions: Record<string, unknown> };
    return Response.json({ model, answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.99 }])),
      usage: { input_tokens: 100, output_tokens: 1 } });
  });
  vi.stubGlobal('fetch', transport);
  const native = fixtureAdapter('codex', f.observedInstructions, 'pass');
  const start = native.start;
  native.start = async input => {
    await writeFile(join(input.workspacePath, 'report.json'), JSON.stringify({ body: input.instructions }));
    return start(input);
  };
  // Leave both registries and all grader factories to the production composition.
  const dependencies = { subjects: { codex: { create: () => native } } };
  const argv = ['train', '--train', 'train.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md'];
  if (entry === 'main') expect(await main(argv, f.io, dependencies), f.stderr.join('')).toBe(0);
  else {
    const previous = process.exitCode;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(f.root);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try { await launch(argv, dependencies); expect(process.exitCode, stderr.mock.calls.flat().join('')).toBe(0); }
    finally { process.exitCode = previous; cwd.mockRestore(); stdout.mockRestore(); stderr.mockRestore(); }
  }
  expect(f.observedInstructions).toHaveLength(6);
  expect(transport).toHaveBeenCalledTimes(6);
  const receipts = (await readFile(receiptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(receipts.filter(row => row.event === 'completed')).toHaveLength(6);
  expect(receipts.every(row => row.route === `decisions:typesafe:${model}`)).toBe(true);
  const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  expect(index).toMatchObject({ schema: 'spawnfile.training.invocation.v1', command: 'train', phase: 'test' });
});
