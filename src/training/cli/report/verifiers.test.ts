import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { runQuestionnaire, testBank, testJudge, testMaterial, testReplies } from '../../questionnaire/index.js';
import { reportFixture } from './fixture.js';
import { renderTrainingMarkdown } from './markdown.js';
import { summarizeTraining } from './summary.js';
import { renderVerifiersMarkdown } from './verifiers.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const grade = (first: Record<string, unknown>) => runQuestionnaire({ bank: testBank(), material: testMaterial, judges: { strong: testJudge([first, testReplies[1]]) } });

it('reports per-question pass rates, gates, hidden against open and critic findings per candidate', async () => {
  const { report, root } = await reportFixture(); roots.push(root);
  const clean = await grade(testReplies[0]!), failing = await grade({ ...testReplies[0]!, figures: { answer: 'no', reason: 'x' }, quotes: { answer: 'yes', reason: 'y' } });
  report.trials.forEach((trial, index) => {
    const graded = trial.candidateId === report.baseline.id ? clean : failing;
    trial.evaluation.stages = [{ id: 'record-checks', gate: { status: 'pass', finality: 'final', reason: '', evidence: [] },
      checks: [{ id: 'house-rules', status: 'pass', finality: 'final', reason: '', evidence: [], score: graded.score!, questionnaire: graded },
        { id: `other-${index}`, status: 'pass', finality: 'final', reason: '', evidence: [] }] }];
  });
  const other = report.trials.find(trial => trial.candidateId !== report.baseline.id)!.candidateId;
  report.critic = { selectedId: report.baseline.id, displacedId: other, reviews: [
    { candidateId: other, validationScore: 0.9, selected: false, review: { verdict: 'block', blockOn: 'high', summary: 'Imports a word quota.',
      findings: [{ category: 'check_only_rule', quoted_line: 'Write 200 to 400 words.', guide_ref: 'WRITING: length', why: 'No guide basis.', severity: 'high' },
        { category: 'case_specific', quoted_line: 'A nomination is not an election.', guide_ref: '', why: 'From the Landtag case.', severity: 'medium', case: 'landtag', unverifiedQuote: true }],
      overlaps: [{ line: 'A nomination is not an election.', cases: [{ id: 'landtag', terms: ['nomina'] }] }] } },
    { candidateId: 'unknown-id', validationScore: null, selected: true, review: { verdict: 'error', blockOn: 'high', summary: '', findings: [], overlaps: [], error: 'critic call failed' } }] };
  const summary = summarizeTraining(report);
  const label = summary.candidates.find(value => value.candidate.id === other)!.label;
  const split = report.trials.find(trial => trial.candidateId === other)!.phase;
  expect(summary.verifiers.questionnaires['house-rules']![split]![label]).toMatchObject({ gatePassed: 0, scoreOpen: 0.3333, scoreHidden: 0.375, gap: -0.0417 });
  expect(Object.values(summary.verifiers.questionnaires['house-rules']!).some(candidates => candidates.baseline?.gatePassed)).toBe(true);
  expect(summary.verifiers.critic!.reviews.map(entry => entry.label)).toEqual([label, 'unknown-id']);
  const markdown = renderTrainingMarkdown(summary, 'bundle', {});
  expect(markdown).toContain('## Questionnaire house-rules');
  expect(markdown).toContain('| Question | Hidden | Gate |');
  expect(markdown).toContain('| quotes | yes |  |');
  expect(markdown).toContain(`## Prompt critic\n\nSelected after review: ${report.baseline.id}. The search's own choice ${other} was removed from selection.`);
  expect(markdown).toContain(`### ${label}: block (removed from selection)\n\nImports a word quota.\n\n- check_only_rule, high: "Write 200 to 400 words.". No guide basis. (WRITING: length)`);
  expect(markdown).toContain('- case_specific, medium, case landtag, quote not found in the prompt: "A nomination is not an election.". From the Landtag case.');
  expect(markdown).toContain('- "A nomination is not an election.": landtag (nomina)');
  expect(markdown).toContain('### unknown-id: error (selected)\n\nReview failed: critic call failed.');
});

it('adds nothing when a run declares neither verifier and skips replaced failed trials', async () => {
  const { report, root } = await reportFixture(); roots.push(root);
  expect(summarizeTraining(report).verifiers).toEqual({ questionnaires: {}, critic: null });
  expect(renderVerifiersMarkdown({ questionnaires: {}, critic: null })).toEqual([]);
  const graded = await grade(testReplies[0]!);
  const trial = report.trials[0]!;
  trial.evaluation.stages = [{ id: 's', gate: { status: 'pass', finality: 'final', reason: '', evidence: [] }, checks: [{ status: 'pass', finality: 'final', reason: '', evidence: [], questionnaire: graded }] }];
  expect(Object.keys(summarizeTraining(report).verifiers.questionnaires)).toEqual(['questionnaire']);
  report.retries = [{ failedTrialId: trial.id, replacementTrialId: 'r', attempt: 1, cause: 'native-infrastructure' } as never];
  expect(summarizeTraining(report).verifiers.questionnaires).toEqual({});
  report.critic = { selectedId: report.selected.id, reviews: [] };
  expect(renderVerifiersMarkdown(summarizeTraining(report).verifiers).join('\n')).toContain(`Selected after review: ${report.selected.id}.\n`);
});
