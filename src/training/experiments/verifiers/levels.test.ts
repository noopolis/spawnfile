import { expect, it } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import type { TrialReport } from '../trials/index.js';
import { trainingFeedback } from '../training/index.js';

const record = (levels: string) => resolveDataset(parseDatasetYaml(`schema: spawnfile.training.dataset.v1
id: writing
checks:
  - {id: length, eval: word-count, input: output.text, min: 200, max: 400${levels}}
  - {id: done, eval: equals, input: output.text, value: "SECRET VALUE"}
records: [{id: assigned-story, group: topic, input: {prompt: File the article.}}]
`)).records[0]!;

const result = (id: string) => ({ id, status: 'fail' as const, finality: 'final' as const, reason: id === 'length' ? 'length wanted 200 to 400 words' : 'done differs', score: 0, evidence: [] });
const report = (): TrialReport => ({ schema: 'spawnfile.training.trial.v1', id: 'trial', phase: 'train', candidateId: 'baseline', datasetDigest: 'dataset', planDigest: 'plan',
  recordId: 'assigned-story', paths: { root: '/private', workspace: '/private', control: '/private', runtimeHome: '/private' },
  status: 'fail', execution: 'completed', hostWork: 'settled', turns: [],
  live: [{ checkId: 'length', boundary: 'event', result: result('length') }] as unknown as TrialReport['live'],
  snapshot: { trialId: 'trial', recordId: 'assigned-story', closed: true, output: 'Answer.', events: [], coverage: [], artifacts: {}, inputFiles: {}, context: {} },
  evaluation: { status: 'fail', checks: {}, scores: {}, stages: [{ id: 'main', checks: [result('length'), result('done')], gate: { status: 'fail', finality: 'final', reason: '', evidence: [] } }] } });

type Shown = { criteria: { checks: Record<string, unknown>[] }[]; evaluation: { stages: { checks: Record<string, unknown>[] }[] }; live: unknown[] };
const shown = (levels: string) => {
  const text = trainingFeedback(record(levels), report()).feedback;
  return { text, value: JSON.parse(text) as Shown };
};

it('shows a check in full when it declares no feedback level', () => {
  const { text, value } = shown('');
  expect(value.criteria[0]!.checks[0]).toMatchObject({ id: 'length', min: 200, max: 400 });
  expect(value.evaluation.stages[0]!.checks[0]).toMatchObject({ id: 'length', reason: 'length wanted 200 to 400 words' });
  expect(text).toContain('200');
});

it('keeps only the id, status and score of a status check: no parameter and no reason', () => {
  const { text, value } = shown(', feedback: status');
  expect(value.criteria[0]!.checks[0]).toEqual({ id: 'length', eval: 'word-count', feedback: 'status' });
  expect(value.evaluation.stages[0]!.checks[0]).toEqual({ id: 'length', status: 'fail', score: 0, finality: 'final' });
  expect(value.live).toEqual([{ checkId: 'length', boundary: 'event', result: { id: 'length', status: 'fail', score: 0, finality: 'final' } }]);
  expect(text).not.toContain('200');
  expect(text).toContain('SECRET VALUE');
});

it('leaves a none check out of criteria, results and live results', () => {
  const { text, value } = shown(', feedback: none');
  expect(value.criteria[0]!.checks.map(check => check.id)).toEqual(['done']);
  expect(value.evaluation.stages[0]!.checks.map(check => check.id)).toEqual(['done']);
  expect(value.live).toEqual([]);
  // A stage gate or weight may still name the id; nothing of its parameters or result remains.
  expect(text).not.toContain('200');
  expect(text).not.toContain('word-count');
});

it('refuses an undeclared feedback level', () => {
  expect(() => record(', feedback: hints')).toThrow(/feedback/u);
});

it('reads levels and criteria through nested logical checks', () => {
  const nested = resolveDataset(parseDatasetYaml(`schema: spawnfile.training.dataset.v1
id: writing
checks:
  - id: both
    all:
      - {id: length, eval: word-count, input: output.text, min: 200, feedback: none}
      - any: [{id: shape, eval: equals, input: output.text, value: "x", feedback: status}, {not: {id: empty, eval: equals, input: output.text, value: ""}}]
records: [{id: assigned-story, group: topic, input: {prompt: File the article.}}]
`)).records[0]!;
  const captured = report();
  captured.evaluation.stages[0]!.checks = [{ ...result('both'), children: [result('length'), { ...result('shape'), reason: 'shape wanted x' }] }];
  const value = JSON.parse(trainingFeedback(nested, captured).feedback) as { criteria: { checks: { all: unknown[] }[] }[]; evaluation: { stages: { checks: { children: unknown[] }[] }[] } };
  expect(value.criteria[0]!.checks[0]!.all).toEqual([{ any: [{ id: 'shape', eval: 'equals', feedback: 'status' }, { not: { id: 'empty', eval: 'equals', input: 'output.text', value: '' } }] }]);
  expect(value.evaluation.stages[0]!.checks[0]!.children).toEqual([{ id: 'shape', status: 'fail', score: 0, finality: 'final' }]);
});
