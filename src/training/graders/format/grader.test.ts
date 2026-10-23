import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGrader, parseGraderYaml, validateGrader, loadGrader, allQuestions } from './grader.js';
import { stableDigest, parseYaml, rejectUnsafeKeys } from './common.js';
import { optionsFor, expectedOptions } from './questions.js';

export function graderInput(): Record<string, unknown> {
  return {
    schema: 'paideia.grader.v1', id: 'writing', golden: 'labels.yaml', calibration: 'calibration.json',
    context: { evidence: { description: 'sources' } },
    teachers: [{ id: 'c', provider: 'claude', model: 'm' }],
    model: { backend: 'teacher', teacher: 'c' }, escalate: { to: 'c', between: [0.3, 0.7] },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }], score: { method: 'weighted' },
  };
}
function question(change: Record<string, unknown>) {
  return { ...graderInput(), questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'], ...change }] };
}

describe('grader formats', () => {
  it('parses defaults, typed options and canonical JSON identity', () => {
    const grader = parseGrader(graderInput());
    expect(grader).toMatchObject({ uncalibrated: 'refuse', gates: [], score: { pass_at: 0 }, questions: [{ weight: 1, not_applicable: 1, level: 'article' }] });
    expect(stableDigest({ b: [2, 1], a: null })).toBe(stableDigest({ a: null, b: [2, 1] }));
    expect(stableDigest([1, 2])).not.toBe(stableDigest([2, 1]));
    expect(parseGrader(question({ type: 'choice', options: ['a', 'b'], expected: ['a'] })).questions[0]?.expected).toEqual(['a']);
    const score = parseGrader(question({ type: 'score', scale: [1, 5], expected: '>= 4' })).questions[0]!;
    expect(optionsFor(score)).toEqual([1, 2, 3, 4, 5]);
    expect(expectedOptions(score)).toEqual([4, 5]);
    expect(expectedOptions({ ...score, expected: '<= 2' })).toEqual([1, 2]);
    expect(parseGrader(question({ ...score, expected: [1, 3] })).questions[0]?.expected).toEqual([1, 3]);
    expect(parseGrader(question({ ...score, expected: 3 })).questions[0]?.expected).toBe(3);
  });

  it.each([
    [{ id: 'q\nr' }, 'id'], [{ id: 'q\u2028r' }, 'id'], [{ id: 'q\u2029r' }, 'id'],
    [{ type: 'choice', options: ['abstain', 'bad'], expected: ['abstain'] }, 'options'],
    [{ expected: 'maybe' }, 'expected'], [{ expected: ['yes'] }, 'expected'],
    [{ type: 'choice', options: ['a', 'a'], expected: ['a'] }, 'options'],
    [{ type: 'choice', expected: ['a'] }, 'options'],
    [{ type: 'choice', options: ['a', 'b'], expected: 'a' }, 'expected'],
    [{ type: 'choice', options: ['a', 'b'], expected: ['a', 'b'] }, 'expected'],
    [{ type: 'choice', options: ['a', 'b'], expected: ['x'] }, 'expected'],
    [{ type: 'choice', options: ['a', 'b', 'c'], expected: ['a', 'a'] }, 'expected'],
    [{ type: 'score', scale: [1, 17], expected: 4 }, 'scale'],
    [{ type: 'score', scale: [2, 2], expected: 2 }, 'scale'],
    [{ type: 'score', expected: 2 }, 'scale'],
    [{ type: 'score', scale: [1.5, 4], expected: 2 }, 'scale'],
    [{ type: 'score', scale: [1, 4], expected: 'invalid' }, 'expected'],
    [{ type: 'score', scale: [1, 4], expected: '>= 1' }, 'expected'],
    [{ type: 'score', scale: [1, 4], expected: [] }, 'expected'],
    [{ options: ['a', 'b'] }, 'options'], [{ scale: [1, 4] }, 'scale'],
    [{ reads: ['sentence'] }, 'reads.0'], [{ reads: ['paragraph'] }, 'reads.0'],
    [{ reads: ['context.unknown'] }, 'reads.0'], [{ reads: ['unknown'] }, 'reads.0'],
    [{ when: { field: 'context.unknown', equals: true } }, 'when.field'],
    [{ when: { field: 'output.a', equals: true, in: [true] } }, 'when'],
    [{ weight: -1 }, 'weight'], [{ weight: 0 }, 'weight'], [{ weight: Infinity }, 'weight'],
    [{ not_applicable: 1.1 }, 'not_applicable'], [{ id: '__proto__' }, 'id'],
  ])('rejects invalid question %j naming field', (change, field) => {
    expect(() => parseGrader(question(change))).toThrow(field);
  });

  it('accepts local reads, predicates and derives applicability questions', () => {
    const grader = parseGrader({ ...question({ level: 'sentence', reads: ['sentence', 'paragraph', 'previous-paragraph', 'next-paragraph', 'context.evidence'], when: 'Does it apply?' }),
      gates: [{ id: 'g', type: 'yes-no', expected: 'no', reads: [] }] });
    expect(allQuestions(grader).map(q => q.id)).toEqual(['q', 'q.applies', 'g']);
    expect(allQuestions(grader)[1]).toMatchObject({ expected: 'yes', ask: 'Does it apply?', level: 'sentence' });
    expect(parseGrader(question({ when: { field: 'output.a', in: [1, 'a'] } }))).toBeDefined();
    expect(parseGrader(question({ when: { field: 'output.a', equals: null } }))).toBeDefined();
  });

  it('enforces unique ids including derived ids and teacher references', () => {
    const base = graderInput();
    expect(() => parseGrader({ ...base, teachers: [{ id: 'c', provider: 'claude', model: 'm' }, { id: 'c', provider: 'grok', model: 'm' }] })).toThrow('teachers.1.id');
    expect(() => parseGrader({ ...base, escalate: { to: 'x', between: [0, 1] } })).toThrow('escalate.to');
    expect(() => parseGrader({ ...base, model: { backend: 'teacher', teacher: 'x' } })).toThrow('model.teacher');
    expect(() => parseGrader({ ...base, gates: [{ id: 'q', check: {} }] })).toThrow('gates.0.id');
    expect(() => parseGrader(question({ id: 'q@p0' }))).toThrow('id');
    expect(() => parseGrader({ ...question({ when: 'Applies?' }), gates: [{ id: 'q.applies', check: {} }] })).toThrow('derived ID collision');
    expect(() => parseGrader({ ...base, gates: [{ id: 'g', type: 'yes-no', expected: 'yes', reads: [], level: 'paragraph' }] })).toThrow('level');
    expect(() => parseGrader({ ...base, gates: [{ id: 'g', type: 'yes-no', expected: 'yes', reads: [], weight: 1 }] })).toThrow('gates');
  });

  it('enforces bound gates through logical nesting without interpreting project parameters', () => {
    const withCheck = (check: unknown) => ({ ...graderInput(), gates: [{ id: 'g', check }] });
    expect(() => parseGrader(withCheck({ eval: 'tool-called' }))).toThrow('gates.0.check.eval');
    expect(() => parseGrader(withCheck({ all: [{ eval: 'tool-count' }] }))).toThrow('check.all.0.eval');
    expect(() => parseGrader(withCheck({ not: { eval: 'tool-sequence' } }))).toThrow('ending_at.event');
    expect(parseGrader(withCheck({ any: [{ eval: 'tool-sequence', ending_at: { event: 'accepted-call' }, steps: [{ bind: { article: 'call.args.article' } }, { where: { cel: 'call.args.article == bindings.article' } }] }] }))).toBeDefined();
    expect(parseGrader(withCheck({ eval: 'project', parameters: { eval: 'tool-count' } }))).toBeDefined();
  });

  it('accepts contained Codex teachers', () => {
    expect(parseGrader({ ...graderInput(), teachers: [{ id: 'c', provider: 'codex', model: 'm' }], escalate: { to: 'c', between: [0.2, 0.8] } }).teachers[0]!.provider).toBe('codex');
    expect(() => parseGrader({ ...graderInput(), teachers: [{ id: 'c', provider: 'unknown', model: 'm' }] }))
      .toThrow('provider');
  });

  it('requires the final gate step to reference a binding from an earlier step', () => {
    for (const steps of [undefined, [], [null], [{ bind: { article: 'call.args.article' } }],
      [{ bind: { article: 'call.args.article' } }, { where: { cel: 'call.success' } }],
      [{ bind: { other: 'call.args.article' } }, { where: { cel: 'call.args.article == bindings.article' } }],
      [{}, { bind: { article: 'call.args.article' }, where: { cel: 'call.args.article == bindings.article' } }]]) {
      expect(() => parseGrader({ ...graderInput(), gates: [{ id: 'g', check: {
        eval: 'tool-sequence', ending_at: { event: 'accepted-call' }, steps,
      } }] })).toThrow('final where.cel');
    }
  });

  it('parses but refuses fitted weights, malformed bands and unknown schema fields', () => {
    const input = { ...graderInput(), score: { method: 'fitted-weights' } };
    expect(parseGrader(input).score.method).toBe('fitted-weights');
    expect(() => validateGrader(input)).toThrow('score.method: fitted-weights not implemented in v1');
    for (const escalate of [{ to: 'c', between: [0.5, 0.5] }, { to: 'c', target_accuracy: 0.5 },
      { to: 'c', between: [0, 1], target_accuracy: 0.9 }, { to: 'c', between: [0, 1], max_calls_per_trial: 0 }]) {
      expect(() => parseGrader({ ...graderInput(), escalate })).toThrow('escalate');
    }
    expect(parseGrader({ ...graderInput(), escalate: { to: 'c', target_accuracy: 1, max_calls_per_trial: 2 },
      model: { backend: 'jev-http', endpoint: 'http://localhost', name: 'model' } })).toBeDefined();
    expect(() => parseGrader({ ...graderInput(), mystery: true })).toThrow('$');
  });

  it('rejects unsafe keys and invalid YAML', () => {
    expect(() => rejectUnsafeKeys(JSON.parse('{"a":{"constructor":1}}'))).toThrow('$.a.constructor');
    expect(() => parseGraderYaml('a: 1\na: 2')).toThrow('unique');
    expect(() => parseYaml('x: &x [1]\ny: *x')).toThrow('aliases');
    expect(() => parseYaml('? [1, 2]\n: v')).toThrow('keys');
    expect(() => parseGraderYaml('!unknown {}')).toThrow('$');
    expect(parseYaml('null')).toBeNull();
  });

  it('accepts inline labels with implied grader and rejects invalid inline labels', () => {
    const golden = { schema: 'paideia.labels.v1', labelers: {}, labels: [] };
    expect(parseGrader({ ...graderInput(), golden }).golden).toEqual(golden);
    expect(() => parseGrader({ ...graderInput(), golden: { ...golden, grader: 'other' } })).toThrow('does not match');
    expect(() => parseGrader({ ...graderInput(), golden: { ...golden, labels: [{ id: 'invalid' }] } })).toThrow('golden');
  });
  it('reports the first YAML error with location and the remaining count', () => {
    expect(() => parseYaml('a: 1\na: 2\na: 3')).toThrow(/YAML line 2, column 1:.*\(1 further errors\)/);
    try { parseYaml('a: 1\na: 2\na: 3'); } catch (error) {
      expect(String(error).length).toBeLessThan(200);
      expect(String(error)).not.toContain('line 3');
    }
  });

  it('loads and resolves both sidecar paths from the grader file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'grader-'));
    try {
      const filename = path.join(directory, 'writing.yaml');
      await writeFile(filename, JSON.stringify(graderInput()));
      expect(await loadGrader(filename)).toMatchObject({ golden: path.join(directory, 'labels.yaml'), calibration: path.join(directory, 'calibration.json') });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

it('validates TypeSafe HTTPS, positive prices and bounded concurrency for legacy and named models', () => {
  const model = { backend: 'typesafe', name: 'jev-1.13.0' };
  const input = graderInput(); delete input.model;
  expect(parseGrader({ ...input, model }).model).toMatchObject({ concurrency: 8 });
  expect(parseGrader({ ...input, models: [{ ...model, id: 'hosted', concurrency: 32 }] }).models![0]).toMatchObject({ concurrency: 32 });
  for (const patch of [{ concurrency: 0 }, { concurrency: 33 }, { concurrency: 1.5 },
    { price_per_mtok_usd: 0 }, { endpoint: 'http://remote.example/v1/systemone' }]) {
    expect(() => parseGrader({ ...input, model: { ...model, ...patch } })).toThrow();
    expect(() => parseGrader({ ...input, models: [{ ...model, ...patch, id: 'hosted' }] })).toThrow();
  }
});
