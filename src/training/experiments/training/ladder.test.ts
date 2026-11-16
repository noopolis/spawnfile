import { expect, it } from 'vitest';
import type { EvaluationResult } from '../../contracts/evaluation.js';
import type { QuestionnaireResult } from '../../questionnaire/index.js';
import type { TrialReport } from '../trials/index.js';
import { declaredScoring, ladderScore, trialLadder } from './ladder.js';
import { trialScore } from './scoring.js';

const ladder = { search: 'ladder' as const };
const check = (id: string, status: 'pass' | 'fail', extra: Partial<EvaluationResult> = {}): EvaluationResult =>
  ({ id, status, finality: 'final', reason: '', evidence: [], ...extra });
const questionnaire = (factor: number | null, rungs: QuestionnaireResult['rungs'] = []) => ({ factor, rungs }) as unknown as QuestionnaireResult;

/** One stage weighted like the newsroom record: house rules 0.55, voice 0.3, values 0.15; gate on filing and house rules. */
function trial(checks: EvaluationResult[], lower: number): TrialReport {
  const status = checks.some(entry => ['filing', 'house'].includes(entry.id!) && entry.status === 'fail') ? 'fail' : 'pass';
  const gate: EvaluationResult = { ...check('gate', status), id: undefined, children: checks.filter(entry => ['filing', 'house'].includes(entry.id!)) };
  return { id: 't', status, execution: 'completed', hostWork: 'settled', stop: { state: 'acknowledged' }, live: [],
    evaluation: { status, checks: {}, scores: {}, stages: [{ id: 'record', checks, gate,
      score: { finality: 'final', lower, upper: lower, assessedWeight: 1, missingWeight: 0 } }] } } as unknown as TrialReport;
}
const article = (house: EvaluationResult, lower: number) => trial([check('filing', 'pass'), house, check('voice', 'pass'), check('values', 'pass')], lower);

it('scores one defect strictly between nothing and a clean article, and two defects strictly below one', () => {
  const clean = article(check('house', 'pass', { questionnaire: questionnaire(1) }), 0.92);
  const one = article(check('house', 'fail', { questionnaire: questionnaire(0.5, [{ id: 'names', factor: 0.5 }]) }), 0.9);
  const two = article(check('house', 'fail', { questionnaire: questionnaire(0.25, [{ id: 'names', factor: 0.5 }, { id: 'figures', factor: 0.5 }]) }), 0.9);
  const cleanScore = trialScore(clean, ladder), oneScore = trialScore(one, ladder), twoScore = trialScore(two, ladder);
  expect(cleanScore).toBe(0.92);
  expect(oneScore).toBe(0.45);
  expect(twoScore).toBe(0.225);
  expect(oneScore).toBeGreaterThan(0);
  expect(oneScore).toBeLessThan(cleanScore);
  expect(twoScore).toBeGreaterThan(0);
  expect(twoScore).toBeLessThan(oneScore);
  // Without the ladder the strict rule stands.
  expect([one, two].map(report => trialScore(report))).toEqual([0, 0]);
  expect(trialScore(one, { search: 'gate' })).toBe(0);
});

it('floors a trial that filed nothing and charges a plain gate its declared penalty', () => {
  const absent = trial([check('filing', 'fail', { absent: true, score: 0 }), check('house', 'fail', { absent: true, score: 0 }),
    check('voice', 'fail', { absent: true, score: 0 }), check('values', 'fail', { absent: true, score: 0 })], 0);
  expect(trialScore(absent, ladder)).toBe(0.05);
  expect(trialScore(absent, { ...ladder, missing_output: 0.1 })).toBe(0.1);
  expect(trialLadder(absent.evaluation, 'fail', ladder)).toMatchObject({ accepted: false, absent: true, factor: 0 });
  // A filing the schema refuses, with no ladder of its own, costs the plain penalty; an unladdered questionnaire too.
  const refused = trial([check('filing', 'fail'), check('house', 'fail', { questionnaire: questionnaire(null) }), check('voice', 'pass')], 0.8);
  expect(trialScore(refused, ladder)).toBe(0.2);
  expect(trialScore(refused, { ...ladder, gate_penalty: 0.75 })).toBe(0.45);
  expect(trialLadder(refused.evaluation, 'fail', ladder).rungs.map(rung => rung.check)).toEqual(['filing', 'house']);
  // A filed article never scores below the floor, and a failed outcome without a failed check is one plain rung.
  expect(ladderScore(refused.evaluation, 'fail', 0, ladder)).toBe(0.05);
  const outcome = article(check('house', 'pass'), 0.9);
  expect(trialLadder(outcome.evaluation, 'fail', ladder)).toMatchObject({ rungs: [{ check: 'trial-outcome', factor: 0.5 }], factor: 0.5 });
  expect(trialLadder(outcome.evaluation, 'pass', ladder)).toMatchObject({ accepted: true, rungs: [], factor: 1 });
});

it('keeps only nondefault scoring policies', () => {
  expect(declaredScoring()).toBeUndefined();
  expect(declaredScoring({ search: 'gate' })).toBeUndefined();
  expect(declaredScoring(ladder)).toEqual(ladder);
  expect(declaredScoring({ deferred: 'stage-score' })).toEqual({ deferred: 'stage-score' });
});
