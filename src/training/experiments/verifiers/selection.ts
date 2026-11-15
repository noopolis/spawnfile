import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateManifest } from '../../candidates/index.js';
import type { CheckNode, ResolvedDataset } from '../../contracts/dataset.js';
import type { EvaluationResult, JudgeCall, PlanEvaluation } from '../../contracts/evaluation.js';
import type { TrainingSelection } from '../../contracts/training-config.js';
import { criticIdentity, criticSelection, rankedCandidates, type CriticGateReport, type CriticReview, type TrainingCriticOptions } from '../../critic/index.js';
import type { DspyResult } from '../../optimization/index.js';
import { summarizeQuestionnaire, type QuestionnaireResult } from '../../questionnaire/index.js';
import type { TrialReport } from '../trials/index.js';

/** One candidate's questionnaire standing on validation: what the optimizer could see against what it could not. */
export interface GapMeasurement {
  /** Validation trials that carry a questionnaire check. */
  trials: number;
  scoreOpen: number | null;
  scoreHidden: number | null;
  /** Open minus hidden. */
  gap: number | null;
  /** Share of those trials whose questionnaire check did not pass its gate; a missing output counts as a failure. */
  gateFailureRate: number | null;
}
export interface GapDecision extends GapMeasurement { candidateId: string; rejected: boolean; reason?: string }
export interface GapGateReport {
  rule: TrainingSelection;
  baseline: GapMeasurement;
  /** Every candidate considered, in selection order. */
  candidates: GapDecision[];
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Ids of the questionnaire checks a dataset declares. */
export function questionnaireCheckIds(dataset: ResolvedDataset): Set<string> {
  const ids = new Set<string>();
  const visit = (node: CheckNode) => {
    if (node.eval === 'questionnaire' && node.id) ids.add(node.id);
    [...node.all ?? [], ...node.any ?? [], ...node.not ? [node.not] : []].forEach(visit);
  };
  for (const record of dataset.records) for (const stage of record.effectiveStages) stage.checks.forEach(visit);
  return ids;
}

/** A candidate's open and hidden questionnaire scores and gate failure rate over its validation trials. */
export function measureGap(trials: readonly TrialReport[], candidateId: string, checkIds: ReadonlySet<string>, evaluation: (trial: TrialReport) => PlanEvaluation): GapMeasurement {
  const graded: QuestionnaireResult[] = [];
  let checks = 0, failed = 0;
  const visit = (check: EvaluationResult) => {
    // A settled questionnaire check counts once: graded, or failed outright because the output is missing.
    if (check.id && checkIds.has(check.id) && (check.status === 'pass' || check.status === 'fail')) {
      checks++;
      if (check.status === 'fail') failed++;
      if (check.questionnaire) graded.push(check.questionnaire);
    }
    check.children?.forEach(visit);
  };
  for (const trial of trials) {
    if (trial.phase !== 'validation' || trial.candidateId !== candidateId || trial.execution === 'failed') continue;
    for (const stage of evaluation(trial).stages) stage.checks.forEach(visit);
  }
  const summary = summarizeQuestionnaire(graded);
  return { trials: checks, scoreOpen: summary.scoreOpen, scoreHidden: summary.scoreHidden, gap: summary.gap, gateFailureRate: checks ? round(failed / checks) : null };
}

/** The declared rule: a candidate may not widen the baseline's open minus hidden gap, or its gate failure rate, past the threshold. */
export function gapDecision(rule: TrainingSelection, baseline: GapMeasurement, candidateId: string, measured: GapMeasurement): GapDecision {
  const reasons: string[] = [];
  if (rule.max_gap !== undefined && measured.gap !== null && baseline.gap !== null && round(measured.gap - baseline.gap) > rule.max_gap) {
    reasons.push(`open minus hidden gap ${measured.gap} exceeds the baseline's ${baseline.gap} by more than ${rule.max_gap}`);
  }
  if (rule.max_gate_failure_rise !== undefined && measured.gateFailureRate !== null && baseline.gateFailureRate !== null
      && round(measured.gateFailureRate - baseline.gateFailureRate) > rule.max_gate_failure_rise) {
    reasons.push(`gate failure rate ${measured.gateFailureRate} exceeds the baseline's ${baseline.gateFailureRate} by more than ${rule.max_gate_failure_rise}`);
  }
  return { candidateId, ...measured, rejected: reasons.length > 0, ...(reasons.length ? { reason: reasons.join('; ') } : {}) };
}

interface CriticCheckpoint { schema: 'spawnfile.training.critic-checkpoint.v1'; identity: string; reviews: Record<string, CriticReview> }

/** Reviews kept beside the training checkpoint, bound to everything a review depends on. An errored review is never kept. */
async function criticCheckpoint(directory: string | undefined, identity: string) {
  const path = directory === undefined ? undefined : join(directory, 'critic.json');
  let reviews: Record<string, CriticReview> = {};
  if (path) {
    const stored = await readFile(path, 'utf8').then(text => JSON.parse(text) as CriticCheckpoint, () => undefined);
    if (stored?.schema === 'spawnfile.training.critic-checkpoint.v1' && stored.identity === identity) reviews = stored.reviews;
  }
  return { reviews, async keep(candidateId: string, review: CriticReview) {
    if (!path || review.verdict === 'error') return;
    reviews = { ...reviews, [candidateId]: review };
    await mkdir(directory!, { recursive: true, mode: 0o700 });
    const value: CriticCheckpoint = { schema: 'spawnfile.training.critic-checkpoint.v1', identity, reviews };
    await writeFile(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  } };
}

export interface SelectionOptions {
  baseline: CandidateManifest;
  train: ResolvedDataset;
  validation: ResolvedDataset;
  optimizer: DspyResult;
  candidateFor: (components: Readonly<Record<string, string>>) => CandidateManifest;
  trials: readonly TrialReport[];
  evaluation: (trial: TrialReport) => PlanEvaluation;
  rule?: TrainingSelection;
  critic?: TrainingCriticOptions;
  /** Where critic reviews are kept across a resume. */
  checkpointDirectory?: string;
  signal?: AbortSignal;
  onProgress?: (event: { type: string; payload: unknown }) => void | Promise<void>;
}

/**
 * Selection after a finished search and before anything is frozen. Candidates are considered in the search's
 * order; the declared gap rule removes those that did better only on what the optimizer could see, then the
 * critic reviews what remains. The baseline is never rejected and always remains selectable.
 */
export async function selectCandidate(options: SelectionOptions): Promise<{ selected: CandidateManifest; critic?: CriticGateReport; gap?: GapGateReport }> {
  let ranked = rankedCandidates(options.optimizer, options.candidateFor);
  let gap: GapGateReport | undefined;
  if (options.rule) {
    const ids = questionnaireCheckIds(options.validation);
    const baseline = measureGap(options.trials, options.baseline.id, ids, options.evaluation);
    const decisions = new Map<string, GapDecision>();
    for (const { candidate } of ranked) {
      if (candidate.id === options.baseline.id || decisions.has(candidate.id)) continue;
      decisions.set(candidate.id, gapDecision(options.rule, baseline, candidate.id, measureGap(options.trials, candidate.id, ids, options.evaluation)));
    }
    gap = { rule: options.rule, baseline, candidates: [...decisions.values()] };
    ranked = ranked.filter(entry => !decisions.get(entry.candidate.id)?.rejected);
    await options.onProgress?.({ type: 'selection.gap', payload: gap });
  }
  if (!options.critic) return { selected: ranked[0]?.candidate ?? options.baseline, ...(gap ? { gap } : {}) };
  const checkpoint = await criticCheckpoint(options.checkpointDirectory, criticIdentity(options.critic, options.baseline, options.train));
  const judgeCalls: JudgeCall[] = [];
  const gate = await criticSelection({ critic: options.critic, baseline: options.baseline, train: options.train, optimizer: options.optimizer,
    candidateFor: options.candidateFor, signal: options.signal, ranked, reviewed: checkpoint.reviews,
    onReview: async (candidateId, review, restored) => {
      if (!restored) await checkpoint.keep(candidateId, review);
      if (review.judgeCall) judgeCalls.push(review.judgeCall);
    } });
  await options.onProgress?.({ type: 'critic.judged', payload: { status: gate.report.selectedId === options.baseline.id ? 'baseline' : 'selected', judgeCalls } });
  await options.onProgress?.({ type: 'critic.reviewed', payload: gate.report });
  return { selected: gate.selected, critic: gate.report, ...(gap ? { gap } : {}) };
}
