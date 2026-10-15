import { assertOriginalPolicy, candidateComponents, deriveCandidate, validateCandidate, type CandidateManifest } from '../../candidates/index.js';
import { includeDecisionCosts, trialScore, type TrainingReport, type TrialReport, type RescoreReport } from '../../experiments/index.js';
import type { EvaluationResult } from '../../contracts/evaluation.js';

export type Split = TrialReport['phase'];
export interface Failure {
  trialId: string; evaluationId: string; candidateId: string; split: Split; exampleId: string;
  check: string; status: EvaluationResult['status']; reason: string;
}
export interface Measurement {
  trialId: string; evaluationId: string; round: number | null; score: number | null; scoreUnavailable: string | null;
  status: TrialReport['status']; durationMs: number | null;
  fidelity: { execution: TrialReport['execution']; measurement: 'native-trial' | 'rescore';
    historical: 'unverified'; declaredIsolation: string | null; captureClosed: boolean;
    coverage: TrialReport['snapshot']['coverage'] };
}
export interface SplitScores {
  meanScore: number | null; observedMean: number | null; complete: boolean;
  examples: { id: string; meanScore: number | null; measurements: Measurement[] }[];
}
export interface ExportCandidate {
  label: string; candidate: CandidateManifest; optimizerIndexes: number[];
  rounds: number[]; selected: boolean; splits: Record<Split, SplitScores>;
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function candidates(report: TrainingReport): ExportCandidate[] {
  const components = Object.fromEntries(candidateComponents(report.baseline).map(value => [value.id, value.text]));
  const key = (value: Record<string, string>) => JSON.stringify(Object.keys(value).sort().map(id => [id, value[id]]));
  validateCandidate(report.selected);
  const entries = new Map<string, { candidate: CandidateManifest; indexes: number[] }>();
  entries.set(report.baseline.id, { candidate: report.baseline, indexes: [] });
  report.optimizer.provenance.candidates.forEach((value, index) => {
    const candidate = key(value.components) === key(components) ? report.baseline
      : deriveCandidate(report.baseline, report.baseline, value.components);
    const entry = entries.get(candidate.id) ?? { candidate, indexes: [] };
    entry.indexes.push(index); entries.set(candidate.id, entry);
  });
  if (!entries.has(report.selected.id)) throw new Error('Selected candidate is absent from optimizer provenance');
  const trialIds = new Set<string>();
  for (const trial of report.trials) {
    if (trial.candidate) {
      assertOriginalPolicy(report.baseline, trial.candidate);
      if (trial.candidate.id !== trial.candidateId) throw new Error('Evaluated candidate identity mismatch');
      if (!entries.has(trial.candidateId)) entries.set(trial.candidateId, { candidate: trial.candidate, indexes: [] });
    }
    if (trial.phase === 'test' && trial.round !== undefined) throw new Error('Sealed test cannot belong to a search round');
    if (!entries.has(trial.candidateId)) throw new Error(`Trial ${trial.id} has an unexportable candidate`);
    if (trialIds.has(trial.id)) throw new Error('Duplicate native trial in training report');
    trialIds.add(trial.id);
    if (!report.partitions[trial.phase].includes(trial.recordId)) throw new Error('Trial is outside its declared split');
  }
  return [...entries.values()].map(({ candidate, indexes }, index) => ({
    label: candidate.id === report.baseline.id ? 'baseline' : `candidate-${index}`,
    candidate, optimizerIndexes: indexes, selected: candidate.id === report.selected.id,
    rounds: [...new Set([...(report.optimizer.provenance.rounds ?? []).filter(round =>
      [...round.parents, ...round.kept, ...round.variants.flatMap(value => value.candidateIndex === null ? [] : [value.candidateIndex])]
        .some(value => indexes.includes(value))).map(value => value.round),
      ...report.trials.filter(trial => trial.candidateId === candidate.id && trial.round !== undefined).map(trial => trial.round!)])].sort((a, b) => a - b),
    splits: {} as Record<Split, SplitScores>,
  }));
}

function measurement(trial: TrialReport, rescored?: RescoreReport, scoring?: TrainingReport['scoring']): Measurement {
  const current = rescored ?? trial;
  let score: number | null = null, scoreUnavailable: string | null = null;
  try { score = trialScore(current, scoring); } catch (error) { scoreUnavailable = String(error); }
  return { trialId: trial.id, evaluationId: current.id, round: trial.round ?? null, score, scoreUnavailable, status: current.status,
    durationMs: trial.durationMs ?? null, fidelity: { execution: trial.execution,
      measurement: rescored ? 'rescore' : 'native-trial', historical: 'unverified',
      declaredIsolation: trial.subject?.isolation ?? null, captureClosed: trial.snapshot.closed,
      coverage: trial.snapshot.coverage } };
}

function failures(trial: TrialReport, rescored?: RescoreReport): Failure[] {
  const current = rescored ?? trial;
  const rows: Failure[] = [];
  const visit = (check: string, value: EvaluationResult, evaluationId: string) => {
    if (value.status !== 'pass') rows.push({ trialId: trial.id, evaluationId, candidateId: trial.candidateId,
      split: trial.phase, exampleId: trial.recordId, check, status: value.status, reason: value.reason });
    value.children?.forEach((child, index) => visit(`${check}/${child.id ?? index}`, child, evaluationId));
    value.grading?.gates.forEach(gate => {
      if (gate.status !== 'pass') rows.push({ trialId: trial.id, evaluationId, candidateId: trial.candidateId,
        split: trial.phase, exampleId: trial.recordId, check: `${check}/grading/gate/${gate.id}`, status: gate.status,
        reason: `Grader gate ${gate.id}: ${gate.status}` });
    });
  };
  Object.entries(current.evaluation.checks).forEach(([id, value]) => visit(`check/${id}`, value, current.id));
  current.evaluation.stages.forEach(stage => {
    visit(`stage/${stage.id}/gate`, stage.gate, current.id);
    stage.checks.forEach((value, index) => visit(`stage/${stage.id}/${value.id ?? index}`, value, current.id));
  });
  trial.turns.forEach(turn => turn.checks.forEach((value, index) => visit(`turn/${turn.id}/${value.id ?? index}`, value, trial.id)));
  trial.live.forEach((value, index) => visit(`live/${value.checkId}/${index}`, value.result, trial.id));
  if (trial.decisiveFailure) visit('decisiveFailure', trial.decisiveFailure, trial.id);
  if (current.status !== 'pass') rows.push({ trialId: trial.id, evaluationId: current.id, candidateId: trial.candidateId,
    split: trial.phase, exampleId: trial.recordId, check: 'trial-outcome', status: current.status,
    reason: current.error ?? `Native execution: ${trial.execution}; host work: ${trial.hostWork}` });
  return rows;
}

function splitScores(report: TrainingReport, candidateId: string, split: Split, trials: TrialReport[],
  rescore?: (trial: TrialReport) => RescoreReport | undefined): SplitScores {
  const examples = report.partitions[split].map(id => {
    const measurements = trials.filter(trial => trial.candidateId === candidateId && trial.phase === split && trial.recordId === id)
      .map(trial => measurement(trial, rescore?.(trial), report.scoring));
    const effective = measurements.filter(value => !report.retries?.some(retry => retry.failedTrialId === value.trialId));
    const complete = effective.length > 0 && effective.every(value => value.score !== null);
    return { id, meanScore: complete ? mean(effective.map(value => value.score!)) : null, measurements };
  });
  const complete = examples.length > 0 && examples.every(value => value.meanScore !== null);
  return { complete, meanScore: complete ? mean(examples.map(value => value.meanScore!)) : null,
    observedMean: mean(examples.flatMap(value => value.meanScore === null ? [] : [value.meanScore])), examples };
}

/** Presentation of existing measurements only: never selects, executes or regrades. */
export function summarizeTraining(report: TrainingReport) {
  const entries = candidates(report);
  const latest = (trial: TrialReport) => report.rescores?.findLast(value => value.runId === trial.id);
  for (const entry of entries) for (const split of ['train', 'validation', 'test'] as const) {
    entry.splits[split] = splitScores(report, entry.candidate.id, split, report.trials, latest);
  }
  const baseline = entries[0]!;
  const selected = entries.find(value => value.selected)!;
  const pairs = baseline.splits.test.examples.map(example => {
    const candidate = selected.splits.test.examples.find(value => value.id === example.id)!;
    return { exampleId: example.id, baselineScore: example.meanScore, selectedScore: candidate.meanScore,
      delta: example.meanScore === null || candidate.meanScore === null ? null : candidate.meanScore - example.meanScore };
  });
  const deltas = pairs.flatMap(pair => pair.delta === null ? [] : [pair.delta]);
  const complete = pairs.length > 0 && deltas.length === pairs.length;
  const meanDelta = complete ? mean(deltas) : null;
  const standardDeviation = complete && deltas.length > 1
    ? Math.sqrt(deltas.reduce((sum, value) => sum + (value - meanDelta!) ** 2, 0) / (deltas.length - 1)) : null;
  const failingChecks = report.trials.flatMap(trial => failures(trial, latest(trial)));
  const failureSummary = [...new Set(failingChecks.map(value => JSON.stringify([value.check, value.status])))].map(key => {
    const [check, status] = JSON.parse(key) as [string, EvaluationResult['status']];
    const matching = failingChecks.filter(value => value.check === check && value.status === status);
    return { check, status, trials: new Set(matching.map(value => value.trialId)).size };
  });
  const costs = includeDecisionCosts(report.costs ?? null, report.trials, report.rescores);
  const count = (role: 'judge' | 'optimizer') => costs && (role === 'judge' || report.costs)
    ? costs.entries.filter(value => value.role === role).length : null;
  const rounds = [...new Set([...(report.optimizer.provenance.rounds ?? []).map(value => value.round),
    ...report.trials.flatMap(trial => trial.round === undefined ? [] : [trial.round])])].sort((a, b) => a - b);
  const roundScores = rounds.map(round => ({
    round, basis: 'Original native measurements in this round; prior captures are separate; tests and later rescores excluded.',
    candidates: entries.filter(entry => entry.candidate.id === report.baseline.id || entry.rounds.includes(round))
      .map(entry => {
        const inRound = report.trials.filter(trial => trial.phase !== 'test' && trial.round === round);
        const available = report.trials.filter(trial => trial.phase !== 'test' && trial.round !== undefined && trial.round <= round);
        const splits = Object.fromEntries((['train', 'validation', 'test'] as const).map(split =>
          [split, splitScores(report, entry.candidate.id, split, inRound)])) as Record<Split, SplitScores>;
        return { candidateId: entry.candidate.id, label: entry.label, splits,
          train: splits.train.meanScore, validation: splits.validation.meanScore, test: null,
          availableThroughRound: {
            train: splitScores(report, entry.candidate.id, 'train', available),
            validation: splitScores(report, entry.candidate.id, 'validation', available),
          } };
      }),
  }));
  return { schema: 'paideia.training-export.v1' as const, id: report.id, selectedCandidateId: report.selected.id,
    ...(report.retries?.length ? { retries: report.retries } : {}),
    baselineCandidateId: report.baseline.id, candidates: entries, rounds: report.optimizer.provenance.rounds ?? [], roundScores,
    unattributedSearchTrialIds: report.trials.filter(trial => trial.phase !== 'test' && trial.round === undefined).map(trial => trial.id),
    heldOut: { ...(report.heldOut.some(arm => arm.trialScores !== undefined) ? { arms: report.heldOut } : {}), complete, pairs, pairedExamples: deltas.length, meanDelta, standardDeviation,
      standardError: standardDeviation === null ? null : standardDeviation / Math.sqrt(deltas.length),
      uncertainty: !complete ? 'Incomplete held-out pairs; no comparison claim.' : deltas.length < 2
        ? 'One paired example; sampling uncertainty is unknown. No generalization claim.'
        : 'Descriptive between-example variation, assuming independent examples; no confidence interval or stochastic-repeat claim.' },
    failingChecks, failureSummary, durationMs: report.durationMs ?? null,
    requests: { judge: count('judge'), optimizer: count('optimizer'), subject: null,
      basis: 'Recorded inference attempts only. Subject turns and usage buckets are not model requests; total HTTP requests are unknown.' },
    costs, costPlan: report.costPlan ?? null,
    fidelity: 'Observed native captures and declared isolation; historical reconstruction fidelity is unverified. Rescores are not independent trials.',
  };
}
export type TrainingSummary = ReturnType<typeof summarizeTraining>;
