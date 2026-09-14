import type { ViewerCheck, ViewerData } from '../types.js';
import type { CandidateIndex } from './candidates.js';
import type { GateSummary, MetricDefinition, MetricSplit, MetricSummary, PairedComparison, TrialMeasurement } from './types.js';

interface TrialMetrics {
  candidateId: string;
  caseId: string;
  split: MetricSplit;
  values: Map<string, number | null>;
  stages: Map<string, ViewerCheck>;
}

const strict: MetricDefinition = { id: 'strict', label: 'Strict gated trial score', kind: 'strict' };
const average = (values: number[]): number | null => values.length === 0
  ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const numeric = (value: number | null): number | null => value !== null
  && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

function distinctChecks(checks: ViewerCheck[]): Map<string, ViewerCheck> {
  const result = new Map<string, ViewerCheck>();
  for (const check of checks) {
    const previous = result.get(check.id);
    result.set(check.id, previous !== undefined && (previous.score !== check.score || previous.status !== check.status)
      ? { ...check, score: null, status: 'unknown' } : check);
  }
  return result;
}

function trialMetrics(trial: ViewerData['trials'][number], index: CandidateIndex,
  definitions: Map<string, MetricDefinition>, stageLabels: Map<string, string>): TrialMetrics {
  const values = new Map<string, number | null>([[strict.id, numeric(trial.score)]]);
  const stages = distinctChecks(trial.checks);
  for (const stage of stages.values()) {
    stageLabels.set(stage.id, stage.label);
    const id = `stage:${stage.id}`;
    const score = numeric(stage.score);
    values.set(id, score);
    if (score !== null) definitions.set(id, { id, label: stage.label, kind: 'stage', stageId: stage.id });
    const named: ViewerCheck[] = [];
    const visit = (check: ViewerCheck) => {
      const generated = check.id.startsWith(`${stage.id}/`)
        && /^(?:gate|\d+)(?:\/\d+)*$/.test(check.id.slice(stage.id.length + 1));
      if (!generated) named.push(check);
      check.children.forEach(visit);
    };
    stage.children.forEach(visit);
    for (const check of distinctChecks(named).values()) {
      const checkId = `check:${JSON.stringify([stage.id, check.id])}`;
      definitions.set(checkId, { id: checkId, label: `${stage.label} / ${check.label}`, kind: 'check', stageId: stage.id });
      values.set(checkId, numeric(check.score));
    }
  }
  return { candidateId: index.resolve(trial.candidateId), caseId: trial.caseId,
    split: index.split(trial.caseId), values, stages };
}

interface MetricSamples { cases: Map<string, number>; observedTrials: number }
interface TrialGroup { trials: TrialMetrics[]; samples: Map<string, MetricSamples> }

/** Materialize only metrics present in this group, including explicit nulls. */
function metricSamples(trials: TrialMetrics[]): Map<string, MetricSamples> {
  const metrics = new Map<string, Map<string, number[]>>();
  for (const trial of trials) {
    for (const [metricId, value] of trial.values) {
      const cases = metrics.get(metricId) ?? new Map<string, number[]>();
      metrics.set(metricId, cases);
      if (value === null) continue;
      const values = cases.get(trial.caseId) ?? [];
      values.push(value);
      cases.set(trial.caseId, values);
    }
  }
  return new Map([...metrics].map(([id, cases]) => [id, {
    cases: new Map([...cases].map(([caseId, values]) => [caseId, average(values)!])),
    observedTrials: [...cases.values()].reduce((sum, values) => sum + values.length, 0),
  }]));
}

function groupTrials(trials: TrialMetrics[]): Map<string, Map<MetricSplit, TrialGroup>> {
  const candidates = new Map<string, Map<MetricSplit, TrialGroup>>();
  for (const trial of trials) {
    const splits = candidates.get(trial.candidateId) ?? new Map<MetricSplit, TrialGroup>();
    candidates.set(trial.candidateId, splits);
    const group = splits.get(trial.split) ?? { trials: [], samples: new Map<string, MetricSamples>() };
    splits.set(trial.split, group);
    group.trials.push(trial);
  }
  for (const splits of candidates.values()) {
    for (const group of splits.values()) group.samples = metricSamples(group.trials);
  }
  return candidates;
}

function gateSummary(trials: TrialMetrics[], candidateId: string, split: MetricSplit,
  stageId: string, label: string, expectedCases: number | null): GateSummary {
  const summary: GateSummary = { candidateId, split, stageId, label, pass: 0, fail: 0, unknown: 0,
    error: 0, skipped: 0, trialCount: trials.length, observedCases: 0, expectedCases };
  const observed = new Set<string>();
  for (const trial of trials) {
    const stage = trial.stages.get(stageId);
    summary[stage?.status ?? 'unknown']++;
    if (stage !== undefined) observed.add(trial.caseId);
  }
  summary.observedCases = observed.size;
  return summary;
}

/** Independent recorded metrics only; no weighting or evaluation is performed here. */
export function summarizeScores(data: ViewerData, index: CandidateIndex): {
  trialMeasurements: TrialMeasurement[]; metrics: MetricDefinition[]; scores: MetricSummary[]; comparisons: PairedComparison[]; gates: GateSummary[];
} {
  const definitions = new Map<string, MetricDefinition>();
  const stageLabels = new Map<string, string>();
  const trials = data.trials.map(trial => trialMetrics(trial, index, definitions, stageLabels));
  const metrics = [...definitions.values()].sort((a, b) => Number(a.kind === 'check') - Number(b.kind === 'check'));
  metrics.push({ ...strict });
  const metricOrder = new Map(metrics.map((metric, order) => [metric.id, order]));
  const grouped = groupTrials(trials);
  const scores: MetricSummary[] = [];
  const comparisons: PairedComparison[] = [];
  const gates: GateSummary[] = [];
  const baselineId = index.groups[0]?.id;
  for (const candidate of index.groups) {
    const splits = grouped.get(candidate.id);
    if (splits === undefined) continue;
    const candidateStages = new Set([...splits.values()].flatMap(group => group.trials.flatMap(trial => [...trial.stages.keys()])));
    for (const split of index.splits.filter(split => splits.has(split))) {
      const group = splits.get(split)!;
      const baseline = baselineId === undefined ? undefined : grouped.get(baselineId)?.get(split);
      const expectedCases = index.expectedCases(split);
      const observed = [...group.samples].filter(([id]) => metricOrder.has(id))
        .sort(([a], [b]) => metricOrder.get(a)! - metricOrder.get(b)!);
      for (const [metricId, sample] of observed) {
        const cases = sample.cases;
        scores.push({ candidateId: candidate.id, split, metricId, value: average([...cases.values()]),
          observedTrials: sample.observedTrials, trialCount: group.trials.length, observedCases: cases.size, expectedCases });
        const baselineSample = baseline?.samples.get(metricId);
        if (candidate.id === baselineId || baselineSample === undefined) continue;
        const baselineCases = baselineSample.cases;
        const matched = [...cases.keys()].filter(id => baselineCases.has(id));
        const baselineValue = average(matched.map(id => baselineCases.get(id)!));
        const candidateValue = average(matched.map(id => cases.get(id)!));
        comparisons.push({ baselineId: baselineId!, candidateId: candidate.id, split, metricId,
          baselineValue, candidateValue, delta: baselineValue === null || candidateValue === null ? null : candidateValue - baselineValue,
          matchedCases: matched.length, expectedCases });
      }
      for (const stageId of candidateStages) {
        gates.push(gateSummary(group.trials, candidate.id, split, stageId, stageLabels.get(stageId)!, expectedCases));
      }
    }
  }
  const trialMeasurements = trials.map((trial, position) => ({ id: data.trials[position]!.id,
    candidateId: trial.candidateId, caseId: trial.caseId, split: trial.split,
    values: Object.fromEntries(trial.values) }));
  return { trialMeasurements, metrics, scores, comparisons, gates };
}
