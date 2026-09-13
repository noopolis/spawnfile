import type { EvaluationResult, JudgeCall } from '../../contracts/evaluation.js';
import type { InferenceModelBasis, ObservationCoverage, Usage } from '../../contracts/execution.js';
import type { TrialReport } from '../trials/index.js';
import type { CostValuation, ModelPrice, Range } from './types.js';
import { valueUsage } from './valuation.js';

export interface OptimizerGeneration {
  text?: string;
  model: string | null;
  modelBasis?: InferenceModelBasis;
  usage: Usage | null;
  route?: string;
  outcome?: string;
}
export interface CostReportOptions {
  subjectModel: string;
  optimizerGenerations?: readonly OptimizerGeneration[];
  prices?: readonly ModelPrice[];
}
export interface CostEntry {
  id: string;
  role: 'subject' | 'judge' | 'optimizer' | 'unattributed';
  name: string;
  trialId?: string;
  model: string | null;
  modelBasis: 'requested-assumption' | 'provider-reported' | 'unknown';
  requestedModel?: string;
  providerId?: string;
  responseRoute?: string | null;
  outcome: string;
  usage: Usage | null;
  valuation: CostValuation;
  /** Evidence reports, not an inferred list of distinct calls or summable deltas. */
  observedUsageReports?: { location: string; usage: Usage[] }[];
  judgeCallVersions?: JudgeCall[];
}
export interface CostGroup {
  role: CostEntry['role'];
  name: string;
  entryCount: number;
  models: (string | null)[];
  apiEquivalentUsd: Range | null;
  knownSubtotalUsd: Range;
  completeness: 'complete' | 'incomplete';
}
export interface CostReport {
  schema: 'paideia.cost-report.v1';
  currency: 'USD';
  /** Only observed entries; usageCoverage and warnings describe capture limitations. */
  apiEquivalentUsd: Range | null;
  knownSubtotalUsd: Range;
  completeness: 'complete' | 'incomplete';
  usageCoverage: 'observed-only' | 'incomplete';
  entries: CostEntry[];
  groups: CostGroup[];
  /** API-equivalent valuation is not an invoice or a subscription quota estimate. */
  subscriptionChargeUsd: null;
  warnings: string[];
}

function unknown(reason: string): CostValuation {
  return { status: 'incomplete', apiEquivalentUsd: null, price: null, assumptions: [reason] };
}

function price(entry: Omit<CostEntry, 'valuation'>, options: CostReportOptions): CostValuation {
  if (entry.model === null || entry.role === 'unattributed') return { ...unknown('No attributable model was reported.'),
    status: entry.usage === null ? 'incomplete' : 'unpriced' };
  try {
    return valueUsage({ role: entry.role, name: entry.name, model: entry.model, billing: 'subscription', usage: entry.usage }, options.prices);
  } catch (error) {
    return unknown(`Invalid cost evidence or rate catalog: ${String(error)}`);
  }
}

function usageKey(usage: Usage): string {
  return JSON.stringify(Object.entries(usage).sort(([left], [right]) => left.localeCompare(right)));
}

function callKey(call: JudgeCall): string {
  return JSON.stringify([call.id, call.judge, call.providerId, call.requestedModel, call.responseModel,
    call.responseRoute, call.outcome, call.usage === null ? null : usageKey(call.usage)]);
}

function completeUsage(coverage: readonly ObservationCoverage[]): boolean {
  const channels = coverage.filter(channel => channel.channel === 'usage');
  return channels.length > 0 && channels.every(channel => channel.completeness === 'complete');
}

/** Observation ids identify reports, not calls. Different reports may overlap. */
function subjectObservations(trial: TrialReport): Map<string, NonNullable<CostEntry['observedUsageReports']>> {
  const wakes = new Map<string, Map<string, Usage[]>>();
  for (const event of trial.snapshot.events) {
    if (event.type !== 'usage') continue;
    const reports = wakes.get(event.wakeId) ?? new Map<string, Usage[]>();
    const versions = reports.get(event.id) ?? [];
    if (event.usage && !versions.some(usage => usageKey(usage) === usageKey(event.usage!))) versions.push(event.usage);
    reports.set(event.id, versions); wakes.set(event.wakeId, reports);
  }
  return new Map([...wakes].map(([wake, reports]) => [wake,
    [...reports].map(([id, usage]) => ({ location: `snapshot.events[${JSON.stringify(id)}]`, usage }))]));
}

function totals(entries: readonly CostEntry[]): Pick<CostReport, 'apiEquivalentUsd' | 'knownSubtotalUsd' | 'completeness'> {
  const knownSubtotalUsd = { low: 0, high: 0 };
  let complete = true;
  for (const entry of entries) {
    const cost = entry.valuation.apiEquivalentUsd;
    if (cost === null) complete = false;
    else { knownSubtotalUsd.low += cost.low; knownSubtotalUsd.high += cost.high; }
  }
  return { apiEquivalentUsd: complete ? { ...knownSubtotalUsd } : null, knownSubtotalUsd,
    completeness: complete ? 'complete' : 'incomplete' };
}

/** Pure observed-call accounting. No provider calls, file reads, or billing claims. */
export function summarizeCosts(trials: readonly TrialReport[], options: CostReportOptions): CostReport {
  const entries: CostEntry[] = [];
  const warnings = new Set(['API-equivalent text-token valuation is separate from subscription charges and quota usage.',
    'Only recorded calls are valued; tool fees and unobserved inference are outside this total.']);
  const subjects = new Set<string>();
  const judges = new Map<string, { trialId: string; versions: JudgeCall[] }>();
  let usageCoverage: CostReport['usageCoverage'] = 'observed-only';
  const append = (entry: Omit<CostEntry, 'valuation'>, valuation = price(entry, options)) => {
    entries.push({ ...entry, valuation });
    if (valuation.apiEquivalentUsd === null) warnings.add(`${entry.role} ${entry.name} (${entry.id}): ${valuation.assumptions.join(' ')}`);
  };
  const rememberJudge = (call: JudgeCall, trialId: string) => {
    const existing = judges.get(call.id);
    if (!existing) judges.set(call.id, { trialId, versions: [call] });
    else if (!existing.versions.some(version => callKey(version) === callKey(call))) existing.versions.push(call);
  };

  for (const trial of trials) {
    if (!completeUsage(trial.snapshot.coverage) || trial.turns.some(turn => !completeUsage(turn.native.coverage))) {
      warnings.add(`${trial.id}: The snapshot or native turns do not declare complete usage coverage; recorded amounts may be partial.`);
      usageCoverage = 'incomplete';
    }
    if (trial.turns.length === 0) {
      warnings.add(`${trial.id}: No subject turn was recorded; launch and usage coverage cannot be established from this report.`);
      usageCoverage = 'incomplete';
    }
    if (trial.execution !== 'completed' || trial.hostWork !== 'settled') {
      warnings.add(`${trial.id}: Execution did not complete with all host work settled; later or unreturned usage may be missing.`);
      usageCoverage = 'incomplete';
    }
    const observations = subjectObservations(trial);
    const nativeTurns = new Map(trial.turns.map(turn => [turn.id, turn]));
    for (const wake of new Set([...nativeTurns.keys(), ...observations.keys()])) {
      const turn = nativeTurns.get(wake), observed = observations.get(wake);
      const reports = observed?.flatMap(report => report.usage) ?? [];
      // A returned turn total takes precedence over its live observations. With
      // no total, retain one observed quantity; never sum untyped cumulative or
      // per-call reports. Unknown missing work still prevents a complete total.
      const usage = turn?.native.usage ?? (reports.length === 1 && observed?.length === 1 ? reports[0]! : null);
      const recovered = !turn?.native.usage && observed !== undefined;
      if (recovered) {
        usageCoverage = 'incomplete';
        warnings.add(`${trial.id}/${wake}: Usage observations exist without a native turn total; amounts may overlap or be missing and are not summed.`);
      }
      // This is an accounting bucket for an existing wake, never a model call id.
      const id = JSON.stringify(['subject', trial.id, wake]);
      if (subjects.has(id)) continue;
      subjects.add(id);
      append({ id, role: 'subject', name: 'subject', trialId: trial.id, model: options.subjectModel,
        requestedModel: options.subjectModel, modelBasis: 'requested-assumption', outcome: turn?.native.status ?? 'unreturned', usage,
        ...(observed ? { observedUsageReports: observed } : {}) });
      warnings.add('Subject valuation assumes the requested model; the actual subject model is not verified by TrialReport.');
    }

    const legacy: NonNullable<CostEntry['observedUsageReports']> = [];
    const visit = (result: EvaluationResult, location: string): Map<string, JudgeCall> => {
      const represented = new Map<string, JudgeCall>();
      for (const call of result.judgeCalls ?? []) { rememberJudge(call, trial.id); represented.set(call.id, call); }
      for (const [index, child] of (result.children ?? []).entries()) {
        for (const [id, call] of visit(child, `${location}.children[${index}]`)) represented.set(id, call);
      }
      const counts = new Map<string, number>();
      for (const call of represented.values()) if (call.usage !== null) {
        const key = usageKey(call.usage); counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const unmatched = (result.usage ?? []).filter(value => {
        const key = usageKey(value), count = counts.get(key) ?? 0;
        if (count === 0) return true;
        counts.set(key, count - 1); return false;
      });
      if (unmatched.length) legacy.push({ location, usage: unmatched });
      return represented;
    };
    for (const call of trial.evaluation.judgeCalls ?? []) rememberJudge(call, trial.id);
    for (const [id, check] of Object.entries(trial.evaluation.checks)) visit(check, `plan.checks.${id}`);
    for (const [index, stage] of trial.evaluation.stages.entries()) {
      stage.checks.forEach((check, offset) => visit(check, `plan.stages[${index}].checks[${offset}]`));
      visit(stage.gate, `plan.stages[${index}].gate`);
    }
    for (const turn of trial.turns) turn.checks.forEach((check, index) => visit(check, `turn.${turn.id}.checks[${index}]`));
    trial.live.forEach((check, index) => visit(check.result, `live[${index}]`));
    if (trial.decisiveFailure) visit(trial.decisiveFailure, 'decisiveFailure');
    if (legacy.length) {
      append({ id: JSON.stringify(['legacy', trial.id]), role: 'unattributed', name: 'legacy-evaluators', trialId: trial.id,
        model: null, modelBasis: 'unknown', outcome: 'unattributed', usage: null, observedUsageReports: legacy },
      unknown('Legacy evaluator usage has no call identity; model attribution and distinct call count are unknown.'));
      usageCoverage = 'incomplete';
    }
  }

  for (const [id, { trialId, versions }] of judges) {
    const call = versions[0]!;
    const entry: Omit<CostEntry, 'valuation'> = { id, role: 'judge', name: call.judge, trialId,
      model: call.responseModel, modelBasis: call.responseModel === null ? 'unknown' : 'provider-reported',
      requestedModel: call.requestedModel, providerId: call.providerId, responseRoute: call.responseRoute,
      outcome: call.outcome, usage: call.usage };
    if (versions.length > 1) {
      append({ ...entry, judgeCallVersions: versions }, unknown('Conflicting representations of one judge call; cost cannot be selected.'));
      usageCoverage = 'incomplete';
    } else append(entry);
  }
  for (const [index, generation] of (options.optimizerGenerations ?? []).entries()) {
    const actualModel = generation.modelBasis === 'requested-assumption' ? null : generation.model;
    append({ id: `optimizer:${index}`, role: 'optimizer', name: 'optimizer', model: actualModel,
      ...(generation.modelBasis === 'requested-assumption' && generation.model !== null ? { requestedModel: generation.model } : {}),
      modelBasis: actualModel === null ? 'unknown' : 'provider-reported', responseRoute: generation.route,
      outcome: generation.outcome ?? 'completed', usage: generation.usage });
  }
  const grouped = new Map<string, CostEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.role, entry.name]);
    const group = grouped.get(key) ?? [];
    group.push(entry); grouped.set(key, group);
  }
  const groups = [...grouped.values()].map(group => ({ role: group[0]!.role, name: group[0]!.name,
    entryCount: group.length, models: [...new Set(group.map(entry => entry.model))], ...totals(group) }));
  if (!entries.length) {
    usageCoverage = 'incomplete';
    warnings.add('No usage entries were observed; this is not evidence of zero billed work.');
  }
  const total = totals(entries);
  if (usageCoverage === 'incomplete') { total.apiEquivalentUsd = null; total.completeness = 'incomplete'; }
  return { schema: 'paideia.cost-report.v1', currency: 'USD', ...total, usageCoverage,
    entries, groups, subscriptionChargeUsd: null, warnings: [...warnings] };
}
