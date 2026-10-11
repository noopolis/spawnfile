import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
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
  await writeFile(join(f.root, 'output.json'), JSON.stringify({ body: [`${f.unit.text} [A1]`] }));
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

it('reports every decomposition as uncovered when its entire trap bundle is removed', async () => {
  const f = await prepared(); await runTraps(f.traps);
  const file = join(f.traps.out, (await readdir(f.traps.out))[0]!);
  await unlink(file);
  const result = await runReference(f.reference, f.dependencies);
  expect(result).toMatchObject({ gate: 'STOP', coverage: { total: 1, covered: 0, uncoveredRate: 1 } });
  expect(result.coverage.uncovered).toHaveLength(1);
  expect(await readFile(result.reportFile, 'utf8')).toContain('Known-answer output coverage: 0/1');
});

it('rejects repeated trap ids instead of inflating the declared trap population', async () => {
  const f = await prepared(); await runTraps(f.traps);
  const file = join(f.traps.out, (await readdir(f.traps.out))[0]!);
  const bundle = JSON.parse(await readFile(file, 'utf8'));
  bundle.traps.push(bundle.traps[0]);
  await writeFile(file, JSON.stringify(bundle));
  await expect(runReference(f.reference, f.dependencies)).rejects.toThrow('Invalid trap checkpoint');
});

it('keeps base instability separate from stable variant adjudications', async () => {
  const f = await prepared(); await runTraps(f.traps);
  let baseAdjudications = 0;
  f.generate.mockImplementation(async request => {
    const prompt = JSON.parse(request.prompt);
    const question = prompt.questions[0];
    const text = (prompt.projection ?? question.evidence).unit.text as string;
    const numeric = !text.includes('12');
    const permutation = question.criteria[0].answer === 'unsupported';
    const adjudication = question.competing !== undefined;
    const answer = adjudication
      ? numeric ? 'unsupported' : permutation || ++baseAdjudications === 1 ? 'supported' : 'unsupported'
      : request.model === 'test-codex' ? 'supported' : 'unsupported';
    return { text: JSON.stringify({ [question.check_id]: { answer } }), model: request.model, route: 'subscription', usage: null };
  });
  const result = await runReference(f.reference, f.dependencies);
  expect(result).toMatchObject({ gate: 'STOP', instability: { items: 1, unstable: 1, rate: 1 },
    variantAdjudication: { items: 2, unstable: 0, rate: 0 } });
});

it('does not call or count unaffected duplicate checks in trap variants', async () => {
  const f = await fixture();
  f.templates.templates.push({ ...f.templates.templates[0]!, id: 'other', traps: {} as typeof f.templates.templates[0]['traps'] });
  await writeFile(f.templatesFile, JSON.stringify(f.templates));
  await runDecompose(f.decompose, f.dependencies); await runTraps(f.traps);
  f.generate.mockImplementation(async request => {
    const prompt = JSON.parse(request.prompt);
    const answer = prompt.projection.unit.text.includes('12') ? 'supported' : 'unsupported';
    return { text: JSON.stringify(Object.fromEntries(prompt.questions.map((question: { check_id: string }) => [question.check_id, { answer }]))),
      model: request.model, route: 'subscription', usage: null };
  });
  const result = await runReference(f.reference, f.dependencies);
  expect(result.gate).toBe('PASS');
  const artifact = JSON.parse(await readFile(result.file, 'utf8'));
  const outputs = Object.entries(artifact.outputs) as [string, { checks: Record<string, unknown> }][];
  expect(outputs.filter(([key]) => key.includes(':')).map(([, output]) => Object.keys(output.checks)))
    .toEqual([['support@claim'], ['support@claim']]);
  expect(outputs.find(([key]) => !key.includes(':'))![1].checks).toHaveProperty('other@claim');
});

it('keeps units with invalid source hints, reports drops and never sends hints to council teachers', async () => {
  const f = await fixture();
  const source_span = 'Fabricated source hint';
  f.generate.mockResolvedValueOnce({ text: JSON.stringify({ units: [{ ...f.unit, source_span }] }),
    model: 'test', usage: null, route: 'subscription' });
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1, rejected: 0, dropped: 1 });
  const files = await readdir(f.decompose.out);
  const load = async (suffix: string) => JSON.parse(await readFile(join(f.decompose.out, files.find(file => file.endsWith(suffix))!), 'utf8'));
  expect(await load('.checkpoint.json')).toMatchObject({ dropped: [{ id: 'claim', field: 'source_span', value: source_span }] });
  const doc = await load('.decomposition.json');
  expect(doc.units).toHaveLength(1);
  expect(doc.units[0]).not.toHaveProperty('source_span');
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ resumed: 1, rejected: 0, dropped: 1 });
  f.generate.mockClear();
  f.generate.mockImplementation(async request => {
    expect(request.prompt).not.toContain(source_span);
    expect(request.prompt).not.toContain('source_span');
    return { text: JSON.stringify({ 'support@claim': { answer: 'supported' } }),
      model: request.model, usage: null, route: 'subscription' };
  });
  await runReference({ ...f.reference, traps: undefined }, f.dependencies);
  expect(f.generate.mock.calls.length).toBeGreaterThan(0);
});
