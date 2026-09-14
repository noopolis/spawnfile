import type { CheckNode, ResolvedDataset, ResolvedRecord } from '../../contracts/dataset.js';
import { builtinEvaluatorDefinitions, validateDatasetSplit } from '../../cases/index.js';
import { partitionTraining } from '../training/index.js';
import { resolveCostAssumptions } from './assumptions.js';
import { valueUsage } from './valuation.js';
import type { CostAssumptions, ModelPrice, Range, TokenAssumption } from './types.js';

export interface PlannedInferenceRoute {
  model: string;
  provider: string;
  fallbacks?: readonly { model: string; provider: string }[];
  attempts?: number;
}

export interface TrainingCostOptions {
  train: ResolvedDataset;
  validation?: ResolvedDataset;
  validationGroups?: readonly string[];
  test: ResolvedDataset;
  subjectModel: string;
  optimizerModel: string;
  judges: Readonly<Record<string, PlannedInferenceRoute & { citationRepairs?: 0 | 1 }>>;
  optimizerRoute?: PlannedInferenceRoute;
  maxTrials: number;
  maxProposals: number;
  assumptions?: Partial<CostAssumptions>;
  prices?: readonly ModelPrice[];
}
export interface PlannedCostLine {
  role: 'subject' | 'judge' | 'optimizer';
  name: string;
  phase: 'development' | 'held-out' | 'optimization';
  model: string;
  provider?: string;
  plannedCalls: number;
  tokensPerCall: TokenAssumption;
  apiEquivalentUsd: Range | null;
  price: ModelPrice | null;
}
export interface TrainingCostPlan {
  schema: 'paideia.training-cost-plan.v1';
  modelCallsMade: 0;
  billing: 'API-equivalent valuation; subscription fees are not apportioned';
  coverage: 'estimated' | 'partial';
  budget: { maxTrials: number; maxProposals: number; metricCalls: number; reservedTestTrials: number };
  datasetDigests: { train: string; test: string; validation?: string };
  /** Always emitted by current planning; absent only in older stored v1 plans. */
  judgeRoutes?: Record<string, PlannedInferenceRoute & { citationRepairs: 0 | 1 }>;
  lines: PlannedCostLine[];
  apiEquivalentUsd: Range | null;
  pricedSubtotalUsd: Range;
  assumptions: CostAssumptions;
  warnings: string[];
}

/** Pure planning over resolved cases. Does not construct an adapter or touch credentials. */
export function planTrainingCost(options: TrainingCostOptions): TrainingCostPlan {
  const judgeRoutes = Object.fromEntries(Object.entries(options.judges).map(([name, route]) => {
    const citationRepairs = route.citationRepairs === undefined ? 0 : route.citationRepairs;
    if (citationRepairs !== 0 && citationRepairs !== 1) throw new Error(`Invalid citation repair policy for judge ${name}`);
    return [name, { ...route, citationRepairs }];
  }));
  for (const [value, max] of [[options.maxTrials, 10000], [options.maxProposals, 1000]]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > max!) throw new Error('Invalid training cost budget');
  }
  const partition = options.validation ? { train: options.train, validation: options.validation }
    : partitionTraining(options.train, options.validationGroups);
  if ([partition.train, partition.validation, options.test].some(dataset => dataset.records.length === 0)) {
    throw new Error('Cost planning requires nonempty training, validation and test partitions');
  }
  validateDatasetSplit(partition.train, options.test, partition.validation);
  const reservedTestTrials = options.test.records.length * 2;
  const metricCalls = options.maxTrials - reservedTestTrials;
  if (metricCalls < partition.validation.records.length) throw new Error('Trial budget cannot cover baseline validation and two held-out passes');
  const assumptions = resolveCostAssumptions(options.assumptions);
  const warnings = new Set<string>([
    'Budget scenario assumes every permitted trial and optimizer proposal is used; early stopping may use less.',
    'Token ranges are uncalibrated assumptions per full subject trial or judge/optimizer call, not a guaranteed spending ceiling.',
    'Prompt growth, tool output and private environment size can exceed these assumptions; calibrate them from recorded trials.',
    'Only standard global API text-token prices are valued; subscription quota percentages, tools and infrastructure are excluded.',
    'Cache creation and unknown session context tiers are included as pricing ranges. No batch discount is assumed.',
  ]);
  const lines: PlannedCostLine[] = [];
  let incomplete = false;
  const omitCost = (warning: string) => { incomplete = true; warnings.add(warning); };
  const add = (role: PlannedCostLine['role'], name: string, phase: PlannedCostLine['phase'], model: string,
    plannedCalls: number, tokensPerCall: TokenAssumption, provider?: string) => {
    const common = { role, name, model, billing: 'subscription', contextTier: 'unknown' as const };
    const low = valueUsage({ ...common, usage: { inputTokens: tokensPerCall.inputTokens.low,
      cachedInputTokens: Math.floor(tokensPerCall.inputTokens.low * tokensPerCall.cacheReadFraction.high),
      outputTokens: tokensPerCall.outputTokens.low, reasoningTokens: null, source: 'planning-assumption' } }, options.prices);
    const high = valueUsage({ ...common, usage: { inputTokens: tokensPerCall.inputTokens.high,
      cachedInputTokens: Math.floor(tokensPerCall.inputTokens.high * tokensPerCall.cacheReadFraction.low),
      outputTokens: tokensPerCall.outputTokens.high, reasoningTokens: null, source: 'planning-assumption' } }, options.prices);
    const apiEquivalentUsd = low.apiEquivalentUsd && high.apiEquivalentUsd
      ? { low: plannedCalls * low.apiEquivalentUsd.low, high: plannedCalls * high.apiEquivalentUsd.high } : null;
    if (apiEquivalentUsd === null) omitCost(`Unpriced ${role} ${name}: exact model ${model} has no usable rate.`);
    lines.push({ role, name, phase, model, provider, plannedCalls, tokensPerCall, apiEquivalentUsd, price: low.price });
  };
  const development = [...partition.train.records, ...partition.validation.records];
  const addRoute = (role: 'judge' | 'optimizer', name: string, phase: PlannedCostLine['phase'],
    route: PlannedInferenceRoute, calls: number, perCall: TokenAssumption) => {
    const routes = [route, ...route.fallbacks ?? []];
    const attempts = route.attempts ?? routes.length;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > routes.length) throw new Error('Invalid planned route attempt budget');
    for (const [index, selected] of routes.slice(0, attempts).entries()) {
      add(role, name, phase, selected.model, calls, perCall, selected.provider);
      if (index && lines.at(-1)!.apiEquivalentUsd) lines.at(-1)!.apiEquivalentUsd!.low = 0;
    }
    if (attempts > 1) warnings.add(`${role} ${name}: reserves every permitted fallback attempt; fallback lower cost is zero and provider prefix-cache reuse is not guaranteed.`);
  };
  add('subject', options.train.subject ?? 'subject', 'development', options.subjectModel, metricCalls, assumptions.subject);
  add('subject', options.train.subject ?? 'subject', 'held-out', options.subjectModel, reservedTestTrials, assumptions.subject);
  const developmentCounts = development.map(record => countChecks(record, omitCost));
  const testCounts = options.test.records.map(record => countChecks(record, omitCost));
  const names = new Set([...developmentCounts, ...testCounts].flatMap(counts => Object.keys(counts)));
  for (const name of names) {
    const route = judgeRoutes[name];
    if (!route) throw new Error(`Missing judge route ${name}`);
    const perCall = assumptions.judges?.[name] ?? assumptions.judge;
    const maxPerMetric = Math.max(...developmentCounts.map(counts => counts[name] ?? 0));
    const testCalls = 2 * testCounts.reduce((sum, counts) => sum + (counts[name] ?? 0), 0);
    const attempts = 1 + route.citationRepairs;
    if (route.citationRepairs) warnings.add(`Judge ${name} reserves one citation repair per check; valid quality failures, authentication/quota failures and malformed JSON are not retried.`);
    if (maxPerMetric) addRoute('judge', name, 'development', route, metricCalls * maxPerMetric * attempts, perCall);
    if (testCalls) addRoute('judge', name, 'held-out', route, testCalls * attempts, perCall);
  }
  addRoute('optimizer', 'reflection', 'optimization', options.optimizerRoute ?? {model: options.optimizerModel, provider: 'claude-subscription'}, options.maxProposals, assumptions.optimizer);
  const pricedSubtotalUsd = lines.reduce((sum, line) => ({ low: sum.low + (line.apiEquivalentUsd?.low ?? 0),
    high: sum.high + (line.apiEquivalentUsd?.high ?? 0) }), { low: 0, high: 0 });
  return { schema: 'paideia.training-cost-plan.v1', modelCallsMade: 0,
    billing: 'API-equivalent valuation; subscription fees are not apportioned', coverage: incomplete ? 'partial' : 'estimated',
    budget: { maxTrials: options.maxTrials, maxProposals: options.maxProposals, metricCalls, reservedTestTrials },
    datasetDigests: { train: options.train.sourceDigest, test: options.test.sourceDigest,
      ...(options.validation ? { validation: options.validation.sourceDigest } : {}) },
    judgeRoutes, lines, apiEquivalentUsd: incomplete ? null : pricedSubtotalUsd, pricedSubtotalUsd, assumptions, warnings: [...warnings] };
}

function countChecks(record: ResolvedRecord, omitCost: (warning: string) => void): Record<string, number> {
  const counts: Record<string, number> = {};
  const visit = (node: CheckNode, live = false) => {
    if (node.eval === 'llm-rubric') {
      if (live) omitCost(`Unbounded live judge ${String(node.judge)}: event frequency is unknown; omitted from finite subtotal.`);
      else counts[node.judge as string] = (counts[node.judge as string] ?? 0) + 1;
    } else if (node.eval && builtinEvaluatorDefinitions[node.eval]?.kind !== 'mechanical') {
      omitCost(`Unsupported cost source ${node.eval}: no declared inference cost model; omitted from subtotal.`);
    }
    for (const child of node.all ?? node.any ?? []) visit(child, live);
    if (node.not) visit(node.not, live);
    // passed/score references reuse results and never cause another model call.
  };
  for (const stage of record.effectiveStages) {
    if (stage.when) visit(stage.when);
    stage.checks.forEach(check => visit(check));
    if (stage.gate) visit(stage.gate);
  }
  for (const turn of record.turns ?? []) for (const check of turn.checks ?? []) visit(check);
  for (const check of record.live.checks) visit(check, true);
  return counts;
}
