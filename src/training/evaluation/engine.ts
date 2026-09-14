import type { CheckNode, LiveCheck, Stage } from '../contracts/dataset.js';
import type { EvaluationContext, EvaluationRegistry, EvaluationResult, PlanEvaluation } from '../contracts/evaluation.js';
import { checkThreshold, collectJudgeCalls, combine, negate, result, weightedScore } from './logic/index.js';

function requireOneOperation(node: CheckNode): void {
  const operators = ['all', 'any', 'not', 'passed', 'score', 'eval'];
  if (operators.filter(key => Object.hasOwn(node, key)).length !== 1) {
    throw new Error('A check requires exactly one operation');
  }
}

function validResult(value: EvaluationResult): boolean {
  return ['pass', 'fail', 'unknown', 'error', 'skipped'].includes(value.status) &&
    ['provisional', 'final'].includes(value.finality) && typeof value.reason === 'string' &&
    Array.isArray(value.evidence) && (value.score === undefined ||
      (Number.isFinite(value.score) && value.score >= 0 && value.score <= 1));
}

function isolatedContext(context: EvaluationContext): EvaluationContext {
  return { ...context,
    snapshot: structuredClone(context.snapshot), results: structuredClone(context.results), scores: structuredClone(context.scores),
    judges: Object.fromEntries(Object.entries(context.judges).map(([id, route]) => {
      const { provider, cache, ...policy } = route;
      return [id, { ...structuredClone(policy),
        ...(cache ? { cache: { persistent: cache.persistent,
          get: cache.get.bind(cache), put: cache.put.bind(cache) } } : {}),
        provider: { id: provider.id, capabilities: structuredClone(provider.capabilities),
          generate: provider.generate.bind(provider) },
      }];
    })),
    embeddings: Object.fromEntries(Object.entries(context.embeddings).map(([id, provider]) => [id, {
      id: provider.id, version: provider.version, embed: provider.embed.bind(provider),
    }])),
  };
}

export async function evaluateNode(check: CheckNode, context: EvaluationContext,
  registry: EvaluationRegistry): Promise<EvaluationResult> {
  if (context.signal?.aborted) return { ...result('error', 'Evaluation cancelled', context.snapshot.closed), id: check.id };
  try {
    requireOneOperation(check);
    let evaluated: EvaluationResult;
    if (check.all || check.any) {
      const children: EvaluationResult[] = [];
      for (const child of check.all ?? check.any!) children.push(await evaluateNode(child, context, registry));
      evaluated = combine(check.all ? 'all' : 'any', children);
    } else if (check.not) evaluated = negate(await evaluateNode(check.not, context, registry));
    else if (check.passed) evaluated = context.results[check.passed] ?? result('unknown', `Missing check ${check.passed}`, context.snapshot.closed);
    else if (check.score) {
      const child = context.results[check.score];
      const score = context.scores[check.score] ?? (child ? weightedScore({ [check.score]: 1 }, context.results) : undefined);
      evaluated = checkThreshold(score, check.at_least!);
    } else if (check.eval) {
      const evaluator = registry[check.eval];
      if (!evaluator) throw new Error(`Unknown evaluator ${check.eval}`);
      const parameters = Object.fromEntries(Object.entries(structuredClone(check)).filter(([key]) => !['id', 'eval', 'on', 'on_fail'].includes(key)));
      evaluator.definition.validate(parameters, check.id ?? check.eval);
      evaluated = structuredClone(await evaluator.evaluate(structuredClone(check), isolatedContext(context)));
      if (!validResult(evaluated)) throw new Error('Evaluator returned an invalid result');
    } else throw new Error('Unresolved or invalid check node');
    return { ...evaluated, id: check.id ?? evaluated.id };
  } catch (error) {
    return { ...result('error', error instanceof Error ? error.message : String(error), context.snapshot.closed), id: check.id };
  }
}

export async function evaluatePlan(stages: readonly Stage[], initial: EvaluationContext,
  registry: EvaluationRegistry): Promise<PlanEvaluation> {
  const checks = { ...initial.results };
  const scores = { ...initial.scores };
  const results: PlanEvaluation['stages'] = [];
  const observed: EvaluationResult[] = [];
  const context = { ...initial, results: checks, scores };
  for (const stage of stages) {
    const eligibility = stage.when ? await evaluateNode(stage.when, context, registry) : result('pass', 'No dependency');
    observed.push(eligibility);
    const children: EvaluationResult[] = [];
    for (const check of stage.checks) {
      const evaluated = eligibility.status === 'pass' ? await evaluateNode(check, context, registry)
        : { ...result('skipped', `Stage dependency ${eligibility.status}`, eligibility.finality === 'final'), id: check.id, children: [eligibility] };
      children.push(evaluated);
      observed.push(evaluated);
      checks[check.id!] = evaluated;
      const weight = stage.score?.linear[check.id!];
      const raw = evaluated.status === 'pass' || evaluated.status === 'fail'
        ? evaluated.score ?? (evaluated.status === 'pass' ? 1 : 0) : null;
      await context.observeMeasurement?.({ stageId: stage.id, criterionId: check.id!, kind: 'criterion',
        status: evaluated.status, score: raw,
        ...(weight === undefined ? {} : { weight, weightedContribution: raw === null ? null :
          raw * weight / Object.values(stage.score!.linear).reduce((sum, value) => sum + value, 0) }) });
    }
    const score = stage.score ? weightedScore(stage.score.linear, checks) : undefined;
    if (score) scores[stage.id] = score;
    const gate = eligibility.status !== 'pass' ? result(eligibility.status, 'Stage dependency not satisfied', eligibility.finality === 'final')
      : stage.gate ? await evaluateNode(stage.gate, context, registry) : combine('all', children);
    checks[stage.id] = gate;
    observed.push(gate);
    results.push({ id: stage.id, checks: children, gate, ...(score ? { score, weights: { ...stage.score!.linear } } : {}) });
    await context.observeMeasurement?.({ stageId: stage.id, criterionId: stage.id, kind: 'gate', status: gate.status,
      score: score?.missingWeight === 0 ? score.lower : null });
  }
  const overall = combine('all', results.map(stage => stage.gate));
  const judgeCalls = collectJudgeCalls(observed);
  return { status: overall.status, stages: results, checks, scores, ...(judgeCalls.length ? { judgeCalls } : {}) };
}

export function mayStop(check: LiveCheck, registry: EvaluationRegistry): boolean {
  if (check.on_fail !== 'stop') return false;
  function mechanical(node: CheckNode): boolean {
    requireOneOperation(node);
    if (node.eval) {
      const definition = registry[node.eval]?.definition;
      return definition?.kind === 'mechanical' && definition.incremental && definition.stopProof;
    }
    if (node.not) return mechanical(node.not);
    const children = node.all ?? node.any;
    return Boolean(children?.length && children.every(mechanical));
  }
  if (!mechanical(check)) throw new Error(`Live stop ${check.id} lacks a mechanical finality contract`);
  return true;
}
