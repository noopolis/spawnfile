import { isTextSelector, textSelectors } from './text-checks.js';
import { resolveGraderCheck } from './grader.js';
import { createHash } from 'node:crypto';
import type { CheckNode, Dataset, DatasetRegistry, LiveCheck, Stage } from '../contracts/dataset.js';
import { builtinEvaluatorDefinitions } from './builtin-evaluators.js';
import { compileJsonSchema } from './json-schema.js';
import { validateBindingReferences } from './turn-bindings.js';
import { checkShape } from './check-schema.js';
import { fail, object, string } from './validation.js';

export interface PlanResolution {
  registry: DatasetRegistry;
  sourceName?: string;
  resolvingGrader?: boolean;
  versions: Record<string, string>;
  artifacts?: ReadonlySet<string>;
  criterionFileDigests?: Record<string, string>;
  criterionFiles?: Map<string, Uint8Array>;
  readCriterionFile?: (path: string) => string | Uint8Array;
}
interface Nature { mechanical: boolean; incremental: boolean; stopProof: boolean }
interface Expanded { node: CheckNode; nature: Nature }
function combine(values: Nature[]): Nature {
  return {
    mechanical: values.every(value => value.mechanical),
    incremental: values.every(value => value.incremental),
    stopProof: values.every(value => value.stopProof),
  };
}
export function normalizeStages(plan: Pick<Dataset, 'checks' | 'stages'>, shorthandId = 'shared-checks'): Stage[] {
  if (plan.stages) return structuredClone(plan.stages);
  if (!plan.checks) return [];
  return [{ id: shorthandId, checks: structuredClone(plan.checks), gate: { all: plan.checks.map(check => ({ passed: check.id! })) } }];
}
function artifacts(node: CheckNode, context: PlanResolution, path: string): void {
  if (!context.artifacts) return;
  const names: string[] = [];
  for (const key of ['input', 'evidence', 'reference', 'source']) {
    for (const selector of textSelectors(node[key])) {
      if (typeof selector === 'string' && selector.startsWith('artifact:')) names.push(selector.slice(9).split('#')[0]!);
    }
  }
  if (node.ending_at) names.push(string(object(node.ending_at, path).artifact, path));
  for (const name of names) if (!context.artifacts.has(name)) fail(path, `undeclared artifact ${name}`);
}
function expand(node: CheckNode, context: PlanResolution, known: ReadonlyMap<string, Nature>,
  path: string, ruleStack: string[] = []): Expanded {
  checkShape(node, path);
  if (node.use) {
    for (const [key, value] of Object.entries(node.with ?? {})) validateBindingReferences(value, new Set(), `${path}.with.${key}`);
    if (ruleStack.includes(node.use) || ruleStack.length > 32) fail(path, 'ruleset expansion cycle or depth limit');
    const ruleset = context.registry.rulesets?.[node.use];
    if (!ruleset) fail(path, `unsupported ruleset ${node.use}`);
    context.versions[`ruleset:${node.use}`] = ruleset.version;
    const expanded = ruleset.expand(structuredClone(node.with ?? {}));
    const result = expand(expanded, context, known, path, [...ruleStack, node.use]);
    return { ...result, node: { ...result.node, ...(node.id ? { id: node.id } : {}) } };
  }
  if (node.eval) {
    const definition = context.registry.evaluators?.[node.eval] ?? builtinEvaluatorDefinitions[node.eval];
    if (!definition) fail(path, `unsupported evaluator ${node.eval}`);
    context.versions[`evaluator:${node.eval}`] = definition.version;
    const { id: _id, eval: _eval, ...parameters } = node;
    for (const [key, value] of Object.entries(parameters)) validateBindingReferences(value, new Set(), `${path}.${key}`);
    definition.validate(parameters, path);
    artifacts(node, context, path);
    const sidecar = node.eval === 'json-schema' && typeof node.schema === 'string' ? node.schema :
      node.eval === 'llm-rubric' && node.rubric && typeof node.rubric === 'object' ?
        (node.rubric as { file?: string }).file : undefined;
    const sidecars = node.eval === 'values-in-source' ? textSelectors(node.source).filter(source => !isTextSelector(source)) : sidecar ? [sidecar] : [];
    for (const sidecar of sidecars) {
      if (!context.readCriterionFile || !context.criterionFileDigests) fail(path, `criterion sidecar requires protected bytes: ${sidecar}`);
      const files = context.criterionFiles ??= new Map<string, Uint8Array>();
      let bytes = files.get(sidecar);
      if (bytes === undefined) {
        bytes = Buffer.from(context.readCriterionFile(sidecar));
        files.set(sidecar, bytes);
      }
      if (node.eval === 'json-schema') compileJsonSchema(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
      context.criterionFileDigests[sidecar] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      context.versions[`criterion-file:${sidecar}`] = context.criterionFileDigests[sidecar];
    }
    if (node.eval === 'llm-rubric') {
      const name = string(node.judge, `${path}.judge`);
      const route = context.registry.judges?.[name];
      if (!route) fail(path, `unresolved judge route ${name}`);
      context.versions[`judge:${name}`] = route.version;
    }
    if (node.eval === 'embedding-similarity') {
      const name = string(node.provider, `${path}.provider`);
      const route = context.registry.embeddings?.[name];
      if (!route) fail(path, `unresolved embedding route ${name}`);
      context.versions[`embedding:${name}`] = route.version;
    }
    const resolvedNode = node.eval === 'grader' ? resolveGraderCheck(node, context, path,
      (gate, gatePath) => expand(gate, context, new Map(), gatePath, ruleStack).node,
      name => Object.hasOwn(builtinEvaluatorDefinitions, name)) : structuredClone(node);
    return { node: resolvedNode, nature: {
      mechanical: definition.kind === 'mechanical', incremental: definition.incremental,
      stopProof: definition.stopProof,
    } };
  }
  if (node.passed || node.score) {
    const id = node.passed ?? node.score!;
    const nature = known.get(id);
    if (!nature) fail(path, `unresolved, forward or cyclic result reference ${id}`);
    return { node: structuredClone(node), nature: node.score ? { ...nature, stopProof: false } : nature };
  }
  const operation = node.all ? 'all' : node.any ? 'any' : 'not';
  const children = operation === 'not' ? [node.not!] : node[operation]!;
  const resolved = children.map((child, index) => expand(child, context, known, `${path}.${operation}[${index}]`, ruleStack));
  return {
    node: { ...(node.id ? { id: node.id } : {}), [operation]: operation === 'not' ? resolved[0]!.node : resolved.map(result => result.node) },
    nature: combine(resolved.map(result => result.nature)),
  };
}
export function resolveStages(stages: Stage[], context: PlanResolution, mechanicalOnly = false): Stage[] {
  const known = new Map<string, Nature>();
  const identities = new Set<string>();
  return stages.map((stage, index) => {
    const path = `stages[${index}]`;
    if (identities.has(stage.id)) fail(path, `duplicate plan ID ${stage.id}`);
    identities.add(stage.id);
    const when = stage.when ? expand(stage.when, context, known, `${path}.when`) : undefined;
    if (when && mechanicalOnly && !when.nature.mechanical) fail(path, 'semantic conditions cannot gate later work');
    const checks = stage.checks.map((check, checkIndex) => {
      const id = check.id!;
      if (identities.has(id)) fail(path, `duplicate plan ID ${id}`);
      identities.add(id);
      const result = expand(check, context, known, `${path}.checks[${checkIndex}]`);
      if (mechanicalOnly && !result.nature.mechanical) fail(path, 'semantic/embedding checks cannot gate a later turn');
      known.set(id, result.nature);
      return result;
    });
    let nature = combine(checks.map(check => check.nature));
    if (when) nature = combine([nature, when.nature]);
    if (stage.score) {
      for (const id of Object.keys(stage.score.linear)) {
        if (!checks.some(check => check.node.id === id)) fail(path, `score component is not a check in this stage: ${id}`);
      }
    }
    known.set(stage.id, nature);
    const gate = stage.gate ? expand(stage.gate, context, known, `${path}.gate`) : undefined;
    if (gate && mechanicalOnly && !gate.nature.mechanical) fail(path, 'semantic/embedding gates cannot block later work');
    if (gate) for (const check of checks) {
      const id = check.node.id!;
      if (!Object.hasOwn(stage.score?.linear ?? {}, id) && !referencesPassed(gate.node, id)) {
        fail(path, `non-gate criterion ${id} requires an explicit score weight`);
      }
    }
    if (gate && referencesPassed(gate.node, stage.id)) fail(path, 'stage gate cannot depend on its own verdict');
    known.set(stage.id, combine([nature, ...(gate ? [gate.nature] : [])]));
    return { id: stage.id, checks: checks.map(check => check.node),
      ...(when ? { when: when.node } : {}), ...(stage.score ? { score: structuredClone(stage.score) } : {}),
      ...(gate ? { gate: gate.node } : {}) };
  });
}
export function resolveLive(checks: LiveCheck[], context: PlanResolution): LiveCheck[] {
  return checks.map((check, index) => {
    const path = `live.checks[${index}]`;
    const { on, on_fail: action = 'continue', ...criterion } = check;
    const resolved = expand(criterion, context, new Map(), path);
    if (!resolved.nature.incremental) fail(path, 'evaluator does not support incremental observation');
    if (action === 'stop' && (!resolved.nature.mechanical || !resolved.nature.stopProof)) {
      fail(path, 'hard stopping requires mechanical finality proofs throughout the criterion');
    }
    if (typeof on !== 'string' && context.artifacts && !context.artifacts.has(on.artifact)) fail(path, `undeclared live artifact ${on.artifact}`);
    return { ...resolved.node, id: check.id, on: structuredClone(on), on_fail: action };
  });
}

function referencesPassed(node: CheckNode, id: string): boolean {
  return node.passed === id || (node.not ? referencesPassed(node.not, id) : false) ||
    [...(node.all ?? []), ...(node.any ?? [])].some(child => referencesPassed(child, id));
}
