import type { CheckNode } from '../contracts/dataset.js';
import type { GraderBinding } from '../cases/index.js';
import { builtinEvaluatorDefinitions } from '../cases/index.js';
import type { EvaluationRegistry, RegisteredEvaluator } from '../contracts/evaluation.js';
import { evaluateSequence, evaluateTextCheck, evaluateText, evaluateTokenEfficiency, evaluateTool } from './mechanical/index.js';
import { evaluateGrader } from './grader.js';
import { evaluateRubric } from './semantic/index.js';
import { evaluateSimilarity } from './embedding/index.js';

/** Captured at construction: only these entries may run without an inference slot. */
const builtinMechanical = new WeakSet<RegisteredEvaluator>();

/** Custom evaluators always take a slot, whatever kind they declare. */
export function isBuiltinMechanical(entry: RegisteredEvaluator | undefined): boolean {
  return entry !== undefined && builtinMechanical.has(entry);
}

export function createEvaluationRegistry(custom: EvaluationRegistry = {}): EvaluationRegistry {
  const functions: Record<string, RegisteredEvaluator['evaluate']> = {
    'word-count': evaluateTextCheck, 'values-in-source': evaluateTextCheck,
    equals: evaluateText, 'contains-any': evaluateText, 'json-schema': evaluateText,
    'tool-called': evaluateTool, 'tool-count': evaluateTool, 'tool-sequence': evaluateSequence,
    'token-efficiency': evaluateTokenEfficiency,
    grader: evaluateGrader,
    'llm-rubric': evaluateRubric, 'embedding-similarity': evaluateSimilarity,
  };
  const builtins: Record<string, RegisteredEvaluator> = Object.fromEntries(Object.entries(functions).map(([id, evaluate]) => [id,
    { definition: builtinEvaluatorDefinitions[id]!, evaluate }]));
  // No builtin reads sibling results. Mechanical checks are pure over the snapshot; a
  // judge's shared cache and an embedding provider serialize the checks that use them.
  const named = <T>(routes: Readonly<Record<string, T>>, name: unknown) =>
    typeof name === 'string' && Object.hasOwn(routes, name) ? routes[name] : undefined;
  for (const entry of Object.values(builtins)) entry.concurrency = () => [];
  builtins['llm-rubric']!.concurrency = (check, context) => {
    const cache = named(context.judges, check.judge)?.cache;
    return cache ? [cache] : [];
  };
  builtins.grader!.concurrency = (check, context) => {
    const route = named(context.graders ?? {}, check.grader);
    const resources = route ? [...route.resources ?? [route.resource]] : [];
    function collect(node: CheckNode): boolean {
      if (node.eval) {
        const nested = (builtins[node.eval] ?? custom[node.eval])?.concurrency?.(node, context);
        if (!nested) return false;
        resources.push(...nested);
        return true;
      }
      const children = node.all ?? node.any ?? (node.not ? [node.not] : undefined);
      return children !== undefined && children.every(collect);
    }
    const binding = check.grader_binding as GraderBinding | undefined;
    return (binding?.gates ?? []).every(gate => collect(gate.check)) ? resources : undefined;
  };
  builtins['embedding-similarity']!.concurrency = (check, context) => {
    const provider = named(context.embeddings, check.provider);
    return provider ? [provider] : [];
  };
  for (const entry of Object.values(builtins)) {
    if (entry.definition.kind === 'mechanical') builtinMechanical.add(entry);
    Object.freeze(entry);
  }
  for (const id of Object.keys(custom)) {
    if (Object.hasOwn(builtins, id)) throw new Error(`Cannot replace builtin evaluator ${id}`);
  }
  return Object.freeze({ ...builtins, ...custom });
}
