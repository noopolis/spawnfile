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
  expect(summarizeTraining(report).verifiers).toEqual({ questionnaires: {}, critic: null, calibration: [], selection: null });
  expect(renderVerifiersMarkdown({ questionnaires: {}, critic: null, calibration: [], selection: null })).toEqual([]);
  const graded = await grade(testReplies[0]!);
  const trial = report.trials[0]!;
  trial.evaluation.stages = [{ id: 's', gate: { status: 'pass', finality: 'final', reason: '', evidence: [] }, checks: [{ status: 'pass', finality: 'final', reason: '', evidence: [], questionnaire: graded }] }];
  expect(Object.keys(summarizeTraining(report).verifiers.questionnaires)).toEqual(['questionnaire']);
  report.retries = [{ failedTrialId: trial.id, replacementTrialId: 'r', attempt: 1, cause: 'native-infrastructure' } as never];
  expect(summarizeTraining(report).verifiers.questionnaires).toEqual({});
  report.critic = { selectedId: report.selected.id, reviews: [] };
  expect(renderVerifiersMarkdown(summarizeTraining(report).verifiers).join('\n')).toContain(`Selected after review: ${report.selected.id}.\n`);
});

it('reports the calibration verdict and the gap rule with candidate labels', async () => {
  const { report, root } = await reportFixture(); roots.push(root);
  const measured = { trials: 2, scoreOpen: 0.9, scoreHidden: 0.5, gap: 0.4, gateFailureRate: 0.5 };
  report.calibration = [{ set: 'calibration/set.json', check: 'house-rules', bank: { id: 'bank', digest: 'sha256:x' }, outputs: 13, judgeCallsAsked: 26,
    report: { defects: 8, caught: 8, gateRequired: 5, gateFailed: 5, cleanBases: 5, cleanBasesFailing: [], cleanFalseAlarms: [], missing: [], rows: [], ok: true } }];
  report.selection = { rule: { max_gap: 0.1 }, baseline: { trials: 2, scoreOpen: 0.8, scoreHidden: 0.75, gap: 0.05, gateFailureRate: null },
    candidates: [{ candidateId: report.baseline.id, ...measured, rejected: true, reason: 'open minus hidden gap 0.4 exceeds the baseline\'s 0.05 by more than 0.1' }, { candidateId: 'unknown-id', ...measured, gap: 0.1, rejected: false }] };
  const summary = summarizeTraining(report).verifiers;
  expect(summary.selection!.candidates.map(entry => entry.label)).toEqual(['baseline', 'unknown-id']);
  const markdown = renderVerifiersMarkdown(summary).join('\n');
  expect(markdown).toContain('## Calibration');
  expect(markdown).toContain('- calibration/set.json on house-rules (bank bank): **pass**. Defects caught 8 of 8; required gates failed 5 of 5; clean outputs failing a gate 0 of 5; clean false alarms 0. 13 outputs, 26 judge calls asked by this invocation.');
  expect(markdown).toContain("by more than 0.1, or its gate failure rate exceeds the baseline's by more than n/a (not declared).");
  expect(markdown).toContain('| baseline | 2 | 0.800 | 0.750 | 0.050 | n/a | n/a | reference |');
  expect(markdown).toContain("| baseline | 2 | 0.900 | 0.500 | 0.400 | 0.500 | n/a | rejected: open minus hidden gap 0.4 exceeds the baseline's 0.05 by more than 0.1 |");
  expect(markdown).toContain('| unknown-id | 2 | 0.900 | 0.500 | 0.100 | 0.500 | n/a | kept |');
});
