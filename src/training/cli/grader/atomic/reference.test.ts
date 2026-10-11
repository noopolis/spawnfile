import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runDecompose, runReference, runTraps } from './index.js';
import { fixture } from './fixtures.js';

async function prepared() {
  const f = await fixture();
  await runDecompose(f.decompose, f.dependencies);
  f.generate.mockImplementation(async request => {
    const prompt = JSON.parse(request.prompt) as { projection?: { unit?: { text: string } }; questions: { check_id: string; evidence?: { unit?: { text: string } } }[] };
    const answer = (text: string | undefined) => text?.includes('12') ? 'supported' : 'unsupported';
    return { text: JSON.stringify(Object.fromEntries(prompt.questions.map(question => [question.check_id,
      { answer: answer((prompt.projection ?? question.evidence)?.unit?.text) }]))),
      model: request.model, usage: null, route: 'subscription' };
  });
  return f;
}

it('generates deterministic traps and scores council references with checkpoint resume and markdown report', async () => {
  const f = await prepared();
  const result = await runTraps(f.traps);
  expect(result.generated).toBe(2);
  expect(await runTraps(f.traps)).toEqual(result);
  const reference = await runReference(f.reference, f.dependencies);
  expect(reference).toMatchObject({ gate: 'PASS', outputs: 3, overall: { total: 2, correct: 2, accuracy: 1 } });
  const artifact = JSON.parse(await readFile(f.reference.out, 'utf8'));
  expect(artifact).toMatchObject({ schema: 'paideia.references.v1', digest: expect.any(String) });
  expect(Object.values(artifact.outputs)).toHaveLength(3);
  expect(await readFile(reference.reportFile, 'utf8')).toContain('Council references: PASS');
  expect(await readFile(reference.reportFile, 'utf8')).toContain('codex: 100.00% agreement');
  const calls = f.generate.mock.calls.length;
  expect(await runReference(f.reference, f.dependencies)).toMatchObject({ gate: 'PASS' });
  expect(f.generate).toHaveBeenCalledTimes(calls);
});

it('stops quality gates without traps, reports window skips and option consistency as unmeasured', async () => {
  const f = await prepared();
  const result = await runReference({ ...f.reference, traps: undefined, teachers: ['codex', 'claude', 'grok'], concurrency: 1 }, f.dependencies);
  expect(result.gate).toBe('STOP');
  const report = await readFile(result.reportFile, 'utf8');
  expect(report).toContain('unmeasured (no validated traps)');
  expect(report).toContain('Skipped grok: Outside Grok window');
  expect(report).toContain('Option-permutation consistency: unmeasured');
  expect(f.generate.mock.calls.filter(([request]) => request.model === 'test-grok')).toHaveLength(0);
});

it('reports failing traps/templates and retains missing council answers as failure', async () => {
  const f = await prepared(); await runTraps(f.traps);
  f.generate.mockImplementation(async request => ({ text: JSON.stringify({ 'support@claim': { answer: 'supported' } }),
    model: request.model, route: 'subscription', usage: null }));
  const result = await runReference(f.reference, f.dependencies);
  expect(result.gate).toBe('STOP');
  expect(await readFile(result.reportFile, 'utf8')).toContain('Failing trap kind: number-substitution');
  expect(await readFile(result.reportFile, 'utf8')).toContain('Failing template: support');
});

it('rejects stale and tampered trap artifacts before starting inference', async () => {
  const f = await prepared(); await runTraps(f.traps);
  await expect(runTraps({ ...f.traps, seed: 'different' })).rejects.toThrow('Stale trap');
  const file = join(f.traps.out, (await readdir(f.traps.out))[0]!);
  const trap = JSON.parse(await readFile(file, 'utf8'));
  trap.traps[0].intended_answers['support@claim'] = 'supported';
  await writeFile(file, JSON.stringify(trap));
  await expect(runReference(f.reference, f.dependencies)).rejects.toThrow('Invalid trap checkpoint');
  trap.decompositionDigest = 'changed';
  await writeFile(file, JSON.stringify(trap));
  await expect(runReference(f.reference, f.dependencies)).rejects.toThrow('Stale trap decomposition');
  trap.decomposition = 'missing';
  await writeFile(file, JSON.stringify(trap));
  await expect(runReference(f.reference, f.dependencies)).rejects.toThrow('Stale trap decomposition');
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('propagates caller cancellation and validates concurrency before processing', async () => {
  const f = await prepared();
  await expect(runTraps({ ...f.traps, signal: AbortSignal.abort() })).rejects.toThrow();
  await expect(runReference({ ...f.reference, signal: AbortSignal.abort() }, f.dependencies)).rejects.toThrow();
  await expect(runReference({ ...f.reference, traps: undefined, concurrency: 0 }, f.dependencies)).rejects.toThrow('concurrency');
  const controller = new AbortController();
  f.generate.mockImplementation(async request => { controller.abort(); request.signal!.throwIfAborted(); throw new Error('unreachable'); });
  await expect(runReference({ ...f.reference, traps: undefined, signal: controller.signal }, f.dependencies)).rejects.toThrow();
});

it('fails closed when a valid decomposition was altered to contain an invented span', async () => {
  const f = await prepared();
  const file = join(f.decompose.out, (await readdir(f.decompose.out)).find(file => file.endsWith('.decomposition.json'))!);
  const doc = JSON.parse(await readFile(file, 'utf8'));
  doc.units[0].text = 'Invented';
  await writeFile(file, JSON.stringify(doc));
  await expect(runTraps(f.traps)).rejects.toThrow('Invalid decomposition spans');
});

it('writes empty trap artifacts and counts discarded mutations', async () => {
  const f = await fixture();
  f.unit.text = 'Alice reported items.';
  f.unit.fields.quantity = '';
  f.templates.templates[0]!.traps = { 'number-substitution': 'unsupported' } as typeof f.templates.templates[0]['traps'];
  await writeFile(join(f.root, 'output.json'), JSON.stringify({ body: [f.unit.text] }));
  await writeFile(f.templatesFile, JSON.stringify(f.templates));
  await runDecompose(f.decompose, f.dependencies);
  const result = await runTraps(f.traps);
  expect(result).toMatchObject({ generated: 0, discarded: 1 });
  const file = join(f.traps.out, (await readdir(f.traps.out))[0]!);
  expect(JSON.parse(await readFile(file, 'utf8')).schema).toBe('paideia.traps.v1');
});

it('counts invalid council answers as wrong trap answers rather than dropping their denominator', async () => {
  const f = await prepared(); await runTraps(f.traps);
  f.generate.mockImplementation(async request => ({ text: '{}', model: request.model, usage: null, route: 'subscription' }));
  const result = await runReference(f.reference, f.dependencies);
  expect(result).toMatchObject({ gate: 'STOP', overall: { correct: 0, total: 2, accuracy: 0 } });
});

it('rejects duplicate trap bundles so repeated artifacts cannot inflate gate accuracy', async () => {
  const f = await prepared(); await runTraps(f.traps);
  const file = join(f.traps.out, (await readdir(f.traps.out))[0]!);
  await writeFile(join(f.traps.out, 'duplicate.traps.json'), await readFile(file));
  await expect(runReference(f.reference, f.dependencies)).rejects.toThrow('Duplicate trap decomposition');
  expect(f.generate).toHaveBeenCalledTimes(2);
});
