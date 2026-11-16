import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateComponents, deriveCandidate, snapshotCandidate } from '../../candidates/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { DspyResult } from '../../optimization/index.js';
import { testBankYaml, type QuestionnaireResult } from '../../questionnaire/index.js';
import type { TrialReport } from '../trials/index.js';
import { gapDecision, measureGap, questionnaireCheckIds, selectCandidate } from './selection.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const dataset = resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'spawnfile.training.dataset.v1', id: 'validation',
  records: [{ id: 'story', group: 'a', input: { prompt: 'File the story.' }, outputs: { output: 'a.json' }, context: { evidence: [], assignment: 'a' },
    checks: [{ id: 'house', eval: 'questionnaire', bank: 'bank.yaml', input: 'artifact:output', context: { evidence: 'context:evidence', assignment: 'context:assignment' } }] }] }), { sourceName: '/p/d.yaml' }),
  { registry: { judges: { strong: { version: '1' } } }, readCriterionFile: () => testBankYaml });

const graded = (open: number, hidden: number, gate: 'pass' | 'fail' = 'pass') => ({ gate, scoreOpen: open, scoreHidden: hidden, score: (open + hidden) / 2, answers: [] }) as unknown as QuestionnaireResult;
const trial = (candidateId: string, result: QuestionnaireResult | 'missing', phase: TrialReport['phase'] = 'validation'): TrialReport => ({ id: `${candidateId}-${Math.random()}`, phase, candidateId, execution: 'completed',
  evaluation: { status: 'pass', checks: {}, scores: {}, stages: [{ id: 's', checks: [result === 'missing'
    ? { id: 'house', status: 'fail', score: 0, reason: 'Graded artifact artifact:output is missing', finality: 'final', evidence: [] }
    : { id: 'house', status: result.gate, score: result.score, reason: '', finality: 'final', evidence: [], questionnaire: result },
  { id: 'other', status: 'fail', score: 0, reason: '', finality: 'final', evidence: [] }], gate: { status: 'pass', finality: 'final', reason: '', evidence: [] } }] } }) as unknown as TrialReport;
const evaluation = (report: TrialReport) => report.evaluation;

it('measures open, hidden and gate failures over a candidate\'s validation trials only', () => {
  const ids = questionnaireCheckIds(dataset);
  expect([...ids]).toEqual(['house']);
  const trials = [trial('c', graded(0.9, 0.5)), trial('c', graded(0.7, 0.5, 'fail')), trial('c', 'missing'), trial('c', graded(0, 0), 'train'), trial('other', graded(0, 1)),
    { ...trial('c', graded(0, 0)), execution: 'failed' } as TrialReport];
  expect(measureGap(trials, 'c', ids, evaluation)).toEqual({ trials: 3, scoreOpen: 0.8, scoreHidden: 0.5, gap: 0.3, gateFailureRate: 0.6667, acceptance: 0 });
  expect(measureGap(trials, 'nobody', ids, evaluation)).toEqual({ trials: 0, scoreOpen: null, scoreHidden: null, gap: null, gateFailureRate: null, acceptance: null });
});

it('rejects a candidate past either declared threshold and never one it cannot measure', () => {
  const baseline = { trials: 2, scoreOpen: 0.8, scoreHidden: 0.75, gap: 0.05, gateFailureRate: 0 };
  expect(gapDecision({ max_gap: 0.1 }, baseline, 'c', { ...baseline, gap: 0.15 })).toMatchObject({ rejected: false });
  expect(gapDecision({ max_gap: 0.1 }, baseline, 'c', { ...baseline, gap: 0.16 })).toMatchObject({ rejected: true, reason: expect.stringContaining('open minus hidden gap 0.16') as string });
  expect(gapDecision({ max_gate_failure_rise: 0.25 }, baseline, 'c', { ...baseline, gap: 0.9, gateFailureRate: 0.5 })).toMatchObject({ rejected: true, reason: expect.stringContaining('gate failure rate 0.5') as string });
  expect(gapDecision({ max_gap: 0.1, max_gate_failure_rise: 0.25 }, baseline, 'c', { ...baseline, gap: null, gateFailureRate: null }).rejected).toBe(false);
  // On the ladder, shipping stays strict: a candidate accepting less often than the baseline is rejected.
  expect(gapDecision({}, { ...baseline, acceptance: 0.75 }, 'c', { ...baseline, acceptance: 0.5 }, true)).toMatchObject({ rejected: true, reason: expect.stringContaining('acceptance rate 0.5') as string });
  expect(gapDecision({}, { ...baseline, acceptance: 0.75 }, 'c', { ...baseline, acceptance: 0.75 }, true).rejected).toBe(false);
  expect(gapDecision({}, { ...baseline, acceptance: 0.75 }, 'c', { ...baseline, acceptance: 0.5 }).rejected).toBe(false);
  expect(gapDecision({ max_gap: 0.1 }, { ...baseline, gap: null }, 'c', { ...baseline, gap: 0.9 }).rejected).toBe(false);
});

async function fixture(replies: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'selection-')); roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), 'Report only what the rows state.\n');
  const baseline = await snapshotCandidate({ sourceRoot: root, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const id = candidateComponents(baseline)[0]!.id;
  const text = { learned: 'Report only what the rows state.\nAnswer the visible questions.\n', plain: 'Report only what the rows state.\nName the country.\n' };
  const candidateFor = (value: Readonly<Record<string, string>>) => value[id] === 'Report only what the rows state.\n' ? baseline : deriveCandidate(baseline, baseline, value);
  const learned = candidateFor({ [id]: text.learned }), plain = candidateFor({ [id]: text.plain });
  const optimizer = { components: { [id]: text.learned }, provenance: { candidates: [
    { components: { [id]: 'Report only what the rows state.\n' }, validationScore: 0.6 }, { components: { [id]: text.plain }, validationScore: 0.7 }, { components: { [id]: text.learned }, validationScore: 0.9 }] } } as unknown as DspyResult;
  let calls = 0;
  const provider: InferenceProvider = { id: 'p', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate() { calls++; return { text: JSON.stringify(replies.shift()), model: 'm', usage: null, route: 'r' }; } };
  const critic = { judge: { name: 'strong', provider, model: 'm' }, guide: [{ name: 'WRITING.md', text: 'Length follows the facts.' }], show: { checks: false, trainTasks: false }, blockOn: 'high' as const };
  const trials = [trial(baseline.id, graded(0.8, 0.75)), trial(learned.id, graded(0.95, 0.6)), trial(plain.id, graded(0.85, 0.8))];
  const events: { type: string; payload: unknown }[] = [];
  const common = { baseline, train: dataset, validation: dataset, optimizer, candidateFor, trials, evaluation, onProgress: (event: { type: string; payload: unknown }) => { events.push(event); } };
  return { root, baseline, learned, plain, critic, common, events, calls: () => calls };
}

it('removes a candidate that only improved on what the optimizer could see, with no critic declared', async () => {
  const { learned, plain, common, events } = await fixture([]);
  const result = await selectCandidate({ ...common, rule: { max_gap: 0.1 } });
  expect(result.selected.id).toBe(plain.id);
  expect(result.critic).toBeUndefined();
  expect(result.gap).toMatchObject({ rule: { max_gap: 0.1 }, baseline: { gap: 0.05 }, candidates: [{ candidateId: learned.id, gap: 0.35, rejected: true }, { candidateId: plain.id, gap: 0.05, rejected: false }] });
  expect(events.map(event => event.type)).toEqual(['selection.gap']);
});

it('keeps the baseline when every candidate is rejected, and the search\'s choice without a rule', async () => {
  const { baseline, learned, common } = await fixture([]);
  expect((await selectCandidate({ ...common, rule: { max_gap: 0 }, trials: [...common.trials, trial(common.candidateFor(common.optimizer.provenance.candidates[1]!.components).id, graded(1, 0))] })).selected.id).toBe(baseline.id);
  expect((await selectCandidate({ ...common, critic: undefined })).selected.id).toBe(learned.id);
});

it('reviews only what the gap rule kept and never pays twice for a kept review', async () => {
  const { root, learned, plain, critic, common, events, calls } = await fixture([{ summary: 'fine', findings: [] }]);
  const first = await selectCandidate({ ...common, rule: { max_gap: 0.1 }, critic, checkpointDirectory: join(root, 'checkpoint') });
  expect(first.selected.id).toBe(plain.id);
  expect(first.critic!.reviews.map(entry => entry.candidateId)).toEqual([plain.id]);
  expect(first.critic!.reviews.map(entry => entry.candidateId)).not.toContain(learned.id);
  expect(calls()).toBe(1);
  expect(JSON.parse(await readFile(join(root, 'checkpoint', 'critic.json'), 'utf8'))).toMatchObject({ schema: 'spawnfile.training.critic-checkpoint.v1', reviews: { [plain.id]: { verdict: 'pass' } } });
  const resumed = await selectCandidate({ ...common, rule: { max_gap: 0.1 }, critic, checkpointDirectory: join(root, 'checkpoint') });
  expect(resumed.selected.id).toBe(plain.id);
  expect(calls()).toBe(1);
  const judged = events.filter(event => event.type === 'critic.judged').map(event => (event.payload as { judgeCalls: unknown[] }).judgeCalls.length);
  expect(judged).toEqual([1, 1]);
  // Another guide is another review: the kept one is not reused.
  await expect(selectCandidate({ ...common, critic: { ...critic, guide: [{ name: 'OTHER.md', text: 'Different.' }] }, checkpointDirectory: join(root, 'checkpoint') })).resolves.toMatchObject({ critic: { reviews: [{ review: { verdict: 'error' } }, { review: { verdict: 'error' } }] } });
  expect(calls()).toBe(3);
});

it('does not keep an errored review, so a resumed run asks again', async () => {
  const { root, learned, critic, common, calls } = await fixture(['not a review', { summary: 'fine', findings: [] }]);
  const first = await selectCandidate({ ...common, critic, checkpointDirectory: join(root, 'checkpoint'), optimizer: { ...common.optimizer, provenance: { candidates: [common.optimizer.provenance.candidates[2]!] } } as DspyResult });
  expect(first.critic!.reviews[0]!.review.verdict).toBe('error');
  const resumed = await selectCandidate({ ...common, critic, checkpointDirectory: join(root, 'checkpoint') });
  expect(resumed.selected.id).toBe(learned.id);
  expect(calls()).toBe(2);
});
