import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runDecompose, runReference, runTraps } from './index.js';
import { fixture } from './fixtures.js';

it.each([
  ['10 dollars or less', true], ['a sum not exceeding 10 dollars', true],
  ['10 dollars or less', false], ['a sum not exceeding 10 dollars', false],
] as const)('runs diagnostic quantity %s with declared known-answer mapping %s', async (quantity, known) => {
  const f = await fixture();
  f.unit.text = `Dr Alice received ${quantity} [A1].`;
  f.unit.fields = { actor: 'Dr Alice', quantity: '10' };
  await writeFile(join(f.root, 'output.json'), JSON.stringify({ body: [f.unit.text, 'Dr Bob spoke.'] }));
  await writeFile(join(f.root, 'evidence.md'), '## A1\nDr Alice received 10 dollars.');
  const templates = { ...f.templates, templates: [{ ...f.templates.templates[0], traps: {
    'number-substitution': { answer: 'unsupported', known_answer: false },
    ...(known ? { 'entity-substitution': { answer: 'unsupported', known_answer: true }, 'option-permutation': 'unchanged' } : {}),
  } }] };
  await writeFile(f.templatesFile, JSON.stringify(templates));
  await runDecompose(f.decompose, f.dependencies);
  f.generate.mockImplementation(async request => {
    const prompt = JSON.parse(request.prompt);
    const answer = prompt.questions[0].evidence.unit.text.includes('Dr Bob') ? 'unsupported' : 'supported';
    return { text: JSON.stringify({ q1: { answer } }), model: request.model, usage: null, route: 'subscription' };
  });
  const base = join(f.root, 'base.json');
  await runReference({ ...f.reference, traps: undefined, out: base }, f.dependencies);
  expect(await runTraps({ ...f.traps, references: base })).toMatchObject({ generated: known ? 3 : 1 });
  const file = join(f.traps.out, (await readdir(f.traps.out))[0]!);
  const bundle = JSON.parse(await readFile(file, 'utf8'));
  const number = bundle.traps.find((trap: { kind: string }) => trap.kind === 'number-substitution');
  expect(number.validation).toEqual({ valid: true, reasons: [] });
  expect(number.mutation).toMatchObject({ value_before: '10', value_after: '11' });
  const result = await runReference(f.reference, f.dependencies);
  expect(result).toMatchObject({ gate: 'STOP', outputs: known ? 4 : 2,
    knownAnswer: { total: 0 }, diagnostic: { total: known ? 2 : 1, correct: known ? 1 : 0 },
    coverage: { total: 1, covered: 0 } });
  expect(result.warnings).toEqual(known ? ['entity-substitution: known_answer coerced to diagnostic; lexical validation cannot prove non-entailment'] : []);
  if (known) expect(await readFile(result.reportFile, 'utf8')).toContain('WARNING: entity-substitution: known_answer coerced to diagnostic');
  expect(result.byKind).not.toHaveProperty('number-substitution');
  expect(await readFile(result.reportFile, 'utf8')).toContain('DIAGNOSTIC accuracy by kind');
  expect(await readFile(result.reportFile, 'utf8')).toContain('number-substitution: 0/1 (0.00%)');
  expect(JSON.parse(await readFile(result.file, 'utf8')).quality.diagnosticByKind['number-substitution'].total).toBe(1);
});
