import { expect, it } from 'vitest';
import type { ResolvedRecord } from '../../contracts/dataset.js';
import type { EvaluationResult } from '../../contracts/evaluation.js';
import { parseBank, runQuestionnaire, testBankYaml, testJudge, testMaterial, testReplies } from '../../questionnaire/index.js';
import type { TrialReport } from '../trials/index.js';
import { trainingFeedback } from './feedback.js';

const bank = parseBank(testBankYaml.replace('instructions: "You are a strict checker."', 'instructions: "You are a strict checker."\npenalty: 0.5')
  .replace('        bands: [{ max: 1, score: 1 }, { max: 3, score: 0.75 }]\n        hidden: true', '        pass_when: { max: 1 }\n        gate: true\n        hidden: true'));
const record = { id: 'r', input: { prompt: 'File it.' }, live: { checks: [] }, effectiveStages: [{ id: 's', checks: [{ id: 'house', eval: 'questionnaire' }, { id: 'filing', eval: 'json-schema' }] }] } as unknown as ResolvedRecord;
const check = (id: string, status: 'pass' | 'fail', extra: Partial<EvaluationResult> = {}): EvaluationResult => ({ id, status, finality: 'final', reason: '', evidence: [], ...extra });
const report = (checks: EvaluationResult[]): TrialReport => ({ id: 't', phase: 'train', status: 'fail', execution: 'completed', live: [],
  snapshot: { output: '', artifacts: {} }, evaluation: { status: 'fail', checks: {}, scores: {},
    stages: [{ id: 's', checks, gate: { ...check('gate', 'fail'), id: undefined, children: checks } }] } }) as unknown as TrialReport;
const ladderOf = (value: TrialReport, scoring?: { search: 'ladder' | 'gate' }) => (JSON.parse(trainingFeedback(record, value, value.evaluation, scoring).feedback) as { ladder?: unknown }).ladder;

it('names the lowest failed rung and the next one without leaking hidden gates', async () => {
  const graded = (first: Record<string, unknown>, unused: number) => runQuestionnaire({ bank, material: testMaterial,
    judges: { strong: testJudge([first, { padding: { answer: 'none', reason: '' }, unused: { answer: unused, reason: 'HIDDEN' } }]) } });
  const open = await graded({ ...testReplies[0]!, figures: { answer: 'no', reason: 'P1' } }, 0);
  expect(ladderOf(report([check('house', 'fail', { questionnaire: open }), check('filing', 'pass')]), { search: 'ladder' }))
    .toEqual({ accepted: false, lowest: 'house gates failed: figures', next: 'Clear gate figures: Is every number in a row?', rungs: 1 });
  const hidden = report([check('house', 'fail', { questionnaire: await graded(testReplies[0]!, 4) }), check('filing', 'pass')]);
  const text = trainingFeedback(record, hidden, hidden.evaluation, { search: 'ladder' }).feedback;
  expect(JSON.parse(text).ladder).toMatchObject({ lowest: 'house failed a withheld gate' });
  expect(text).not.toContain('unused');
  expect(ladderOf(report([check('house', 'fail', { absent: true }), check('filing', 'fail', { absent: true })]), { search: 'ladder' }))
    .toMatchObject({ lowest: 'nothing filed', rungs: 2 });
  expect(ladderOf(report([check('house', 'pass'), check('filing', 'fail')]), { search: 'ladder' })).toMatchObject({ lowest: 'filing failed', next: 'Pass filing.' });
  const passing = { ...report([check('house', 'pass')]), status: 'pass' } as TrialReport;
  passing.evaluation.stages[0]!.gate = check('gate', 'pass');
  expect(ladderOf(passing, { search: 'ladder' })).toEqual({ accepted: true, next: 'Every gate passes; raise the graded scores.' });
  expect(ladderOf(passing)).toBeUndefined();
  expect(ladderOf(passing, { search: 'gate' })).toBeUndefined();
});
