import { expect, it } from 'vitest';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';
import { createEvaluationRegistry, evaluateNode } from '../index.js';

const registry = createEvaluationRegistry();
const context = (body: unknown, source: unknown = '') => evaluationContext({
  snapshot: snapshot({ artifacts: { article: artifact({ body }) }, context: { grounding: source as string } }),
});
const words = { eval: 'word-count', input: 'artifact:article#/body', min: 3, max: 3, ignore: ['\\[E\\d+\\]'] };
const values = { eval: 'values-in-source', input: 'artifact:article#/body', source: 'context:grounding' };

it('counts strings/paragraphs with Unicode words, internal apostrophes and hyphens, stripping ignored text', async () => {
  for (const body of ["L’été costs twenty-one. [E12]", ["L’été costs", 'twenty-one. [E12]']]) {
    expect(await evaluateNode(words, context(body), registry)).toMatchObject({ status: 'pass', score: 1, mechanicalEvidence: { count: 3 },
      evidence: [{ kind: 'artifact' }] });
  }
  for (const body of ['one two', 'one two three four']) expect((await evaluateNode(words, context(body), registry)).status).toBe('fail');
  expect(await evaluateNode({ ...words, min: 0, max: 0 }, context(''), registry)).toMatchObject({ status: 'pass', mechanicalEvidence: { count: 0 } });
  expect((await evaluateNode({ eval: 'word-count', input: 'output.text', min: 1 }, context(''), registry)).status).toBe('pass');
  expect((await evaluateNode({ eval: 'word-count', input: ['artifact:article#/body', 'context:grounding'], max: 1 }, context('one', 'two'), registry)).status).toBe('fail');
  expect((await evaluateNode({ eval: 'word-count', input: 'input:files', min: 2 }, context(''), registry)).status).toBe('pass');
  expect((await evaluateNode(words, context('one two three'), registry)).finality).toBe('final');
  const open = context('one two three'); open.snapshot.closed = false;
  expect((await evaluateNode(words, open, registry)).finality).toBe('provisional');
});

it('normalizes grouped numbers, decimals, currency symbols/codes and percentages without matching substrings', async () => {
  const article = ['$1,234.50; €2 000; £03.00; ¥4; 25 %; −5; +6.00; 9007199254740993; 000.00; -0.0', '“steady growth” and "a promise"'];
  const source = 'USD1234.5 EUR2000 GBP3 JPY4 25% -5 6 9,007,199,254,740,993 0 steady   growth a promise';
  expect(await evaluateNode(values, context(article, source), registry)).toMatchObject({ status: 'pass', score: 1,
    mechanicalEvidence: { found: 12, total: 12, missing: [] }, evidence: [{ kind: 'artifact' }, { kind: 'sidecar' }] });
  const failed = await evaluateNode(values, context('12 21% $5 "wrong quote"', '112 21 €5'), registry);
  expect(failed).toMatchObject({ status: 'fail', score: 0, mechanicalEvidence: { missing: ['12', '21%', '$5', '"wrong quote"'] } });
});

it('retains every occurrence, reports missing values, applies ignores to both texts and respects max_missing', async () => {
  expect(await evaluateNode(values, context('10 20 20 "true" "false"', '10 true'), registry)).toMatchObject({ status: 'fail', score: 0.4,
    mechanicalEvidence: { found: 2, total: 5, missing: ['20', '20', '"false"'] } });
  expect(await evaluateNode({ ...values, max_missing: 3 }, context('10 20 20 "true" "false"', '10 true'), registry)).toMatchObject({ status: 'pass', score: 0.4 });
  expect(await evaluateNode({ ...values, ignore: ['\\[E\\d+\\]'] }, context('10 [E12]', '10 [E13]'), registry)).toMatchObject({ status: 'pass', mechanicalEvidence: { total: 1 } });
  expect(await evaluateNode({ ...values, ignore: ['secret "[^"]+"'] }, context('secret "hidden"', 'empty'), registry)).toMatchObject({ status: 'pass', score: 1, mechanicalEvidence: { total: 0 } });
});

it('matches quote edge punctuation and typography while keeping inner text exact', async () => {
  const article = '"disguised coup," “...steady  growth!” "it’s a turn—around"';
  expect(await evaluateNode(values, context(article, 'disguised coup. steady\ngrowth; it\'s a turn-around.'), registry))
    .toMatchObject({ status: 'pass', mechanicalEvidence: { found: 3, total: 3 } });
  expect(await evaluateNode(values, context('"a \'promise\'—kept"', 'a ‘promise’-kept'), registry)).toMatchObject({ status: 'pass' });
  expect(await evaluateNode(values, context('“a "promise"—kept”', 'a “promise”-kept'), registry)).toMatchObject({ status: 'pass' });
  for (const quote of ['absent quote,', 'disguised, coup', 'Disguised coup', '...']) {
    expect(await evaluateNode(values, context(`"${quote}"`, 'disguised coup.'), registry))
      .toMatchObject({ status: 'fail', mechanicalEvidence: { found: 0, total: 1, missing: [`"${quote}"`] } });
  }
});

it('collects structured string and number leaves in document order on inputs and sources', async () => {
  const keyNumbers = [{ label: 'Total items', value: 10, unused: null }, { label: 'Price', value: 2.5,
    nested: ['"steady growth"', { note: 'confirmed', enabled: true }] }];
  expect(await evaluateNode({ ...words, min: 9, max: 9 }, context(keyNumbers), registry))
    .toMatchObject({ status: 'pass', mechanicalEvidence: { count: 9 } });
  expect(await evaluateNode(values, context(keyNumbers, { facts: [10, { amount: 2.5, quote: 'steady growth' }] }), registry))
    .toMatchObject({ status: 'pass', mechanicalEvidence: { found: 3, total: 3 } });
  expect(await evaluateNode(values, context([{ first: 20, second: [10, { third: 30 }] }], 'unrelated'), registry))
    .toMatchObject({ status: 'fail', mechanicalEvidence: { missing: ['20', '10', '30'] } });
  expect(await evaluateNode({ ...words, min: 1, max: 1 }, context(42), registry)).toMatchObject({ status: 'pass' });
  expect(await evaluateNode(values, context({ field12: 'no numbers', flag: false }, 'nothing'), registry))
    .toMatchObject({ status: 'pass', mechanicalEvidence: { total: 0 } });
});

it('reads multiple protected source files/selectors and keeps their evidence', async () => {
  const ctx = context('10 "found"', '10');
  ctx.readText = async name => { expect(name).toBe('source.md'); return 'found'; };
  expect(await evaluateNode({ ...values, source: ['context:grounding', 'source.md'] }, ctx, registry)).toMatchObject({ status: 'pass',
    evidence: [{ kind: 'artifact' }, { kind: 'sidecar' }, { kind: 'sidecar', id: 'source.md' }] });
  ctx.readText = async () => { throw new Error('unreadable source'); };
  expect(await evaluateNode({ ...values, source: 'source.md' }, ctx, registry)).toMatchObject({ status: 'error' });
});

it('never turns missing or malformed evidence into a pass', async () => {
  for (const check of [words, values]) {
    for (const body of [null, {}, [], true, { flag: false, nothing: null }, NaN, Infinity]) {
      expect((await evaluateNode(check, context(body), registry)).status).toBe('error');
    }
    const absent = context(''); absent.snapshot.artifacts = {};
    expect((await evaluateNode(check, absent, registry)).status).toBe('unknown');
    absent.snapshot.subjectUsage = { status: 'complete', usage: null };
    expect((await evaluateNode(check, absent, registry)).status).toBe('fail');
  }
  const absent = context('10'); absent.snapshot.context = {};
  expect(await evaluateNode(values, absent, registry)).toMatchObject({ status: 'unknown' });
  expect(await evaluateNode(values, context('10', null), registry)).toMatchObject({ status: 'error' });
});
