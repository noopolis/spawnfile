import { isDeepStrictEqual } from 'node:util';
import type { CheckNode, Stage } from '../contracts/dataset.js';
import type { EvaluationRegistry, EvaluationResult, PlanEvaluation } from '../contracts/evaluation.js';

/** Evaluator-owned originals must come from an integrity-verified capture. */
export interface PlanMeasurementRepair {
  originalStages: readonly Stage[];
  original: PlanEvaluation;
  /** Structural paths, independent of optional nested check IDs. */
  errorPaths: readonly string[];
}
export type CheckReuse = (path: string) => EvaluationResult | undefined;

/** Selective repair never authorizes a different plan or rerolls a valid grade. */
export function measurementRepair(stages: readonly Stage[], repair: PlanMeasurementRepair,
  registry: EvaluationRegistry): CheckReuse {
  if (!isDeepStrictEqual(stages, repair.originalStages)) throw new Error('Measurement repair changed the original plan');
  if (!repair.errorPaths.length || new Set(repair.errorPaths).size !== repair.errorPaths.length) {
    throw new Error('Measurement repair requires unique error leaf paths');
  }
  const selected = new Set(repair.errorPaths);
  const found = new Set<string>();
  const reusable = new Map<string, EvaluationResult>();
  const visit = (node: CheckNode, prior: EvaluationResult, path: string): boolean => {
    if (!prior || prior.finality !== 'final' || (node.id !== undefined && node.id !== prior.id)) {
      throw new Error('Measurement repair original check binding is invalid');
    }
    if (prior.status === 'pass' || prior.status === 'fail') {
      if ([...selected].some(target => target === path || target.startsWith(path + '/'))) {
        throw new Error('Measurement repair cannot reroll a resolved pass/fail check');
      }
      reusable.set(path, structuredClone(prior));
      return false;
    }
    if (selected.has(path)) {
      if (!node.eval || registry[node.eval]?.definition.kind !== 'semantic' || prior.status !== 'error'
          || !prior.judgeCalls?.some(call => call.outcome !== 'completed')) {
        throw new Error('Measurement repair may target only failed semantic inference leaves');
      }
      found.add(path);
      return true;
    }
    const operator = node.all ? 'all' : node.any ? 'any' : node.not ? 'not' : undefined;
    const children = node.all ?? node.any ?? (node.not ? [node.not] : []);
    let changed = false;
    if (children.length) {
      if (prior.children?.length !== children.length) throw new Error('Measurement repair original child bindings differ');
      children.forEach((child, index) => {
        const childPath = `${path}/${operator}${operator === 'not' ? '' : `/${index}`}`;
        changed = visit(child, prior.children![index]!, childPath) || changed;
      });
    }
    if (!changed) reusable.set(path, structuredClone(prior));
    return changed;
  };
  if (repair.original.stages.length !== stages.length) throw new Error('Measurement repair original stage bindings differ');
  stages.forEach((stage, index) => {
    const original = repair.original.stages[index]!;
    if (stage.id !== original.id || stage.checks.length !== original.checks.length) {
      throw new Error('Measurement repair original stage bindings differ');
    }
    // Eligibility and gates are recomputed from check references. Evaluator calls
    // outside declared checks have no separately captured leaf to repair safely.
    const referencesOnly = (node: CheckNode): boolean => !node.eval &&
      (node.all ?? node.any ?? (node.not ? [node.not] : [])).every(referencesOnly);
    if ((stage.when && !referencesOnly(stage.when)) || (stage.gate && !referencesOnly(stage.gate))) {
      throw new Error('Measurement repair requires reference-only stage dependencies and gates');
    }
    stage.checks.forEach((check, position) => visit(check, original.checks[position]!, `/stages/${index}/checks/${position}`));
  });
  if (found.size !== selected.size) throw new Error('Measurement repair names an unknown error leaf');
  return path => {
    const prior = reusable.get(path);
    return prior === undefined ? undefined : structuredClone(prior);
  };
}

/** Admit a repair before spending its durable recovery reservation. */
export function validateMeasurementRepair(stages: readonly Stage[], repair: PlanMeasurementRepair,
  registry: EvaluationRegistry): void {
  measurementRepair(stages, repair, registry);
}
