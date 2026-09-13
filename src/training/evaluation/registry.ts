import { builtinEvaluatorDefinitions } from '../cases/index.js';
import type { EvaluationRegistry, RegisteredEvaluator } from '../contracts/evaluation.js';
import { evaluateSequence, evaluateText, evaluateTool } from './mechanical/index.js';
import { evaluateRubric } from './semantic/index.js';
import { evaluateSimilarity } from './embedding/index.js';

export function createEvaluationRegistry(custom: EvaluationRegistry = {}): EvaluationRegistry {
  const functions: Record<string, RegisteredEvaluator['evaluate']> = {
    equals: evaluateText, 'contains-any': evaluateText, 'json-schema': evaluateText,
    'tool-called': evaluateTool, 'tool-count': evaluateTool, 'tool-sequence': evaluateSequence,
    'llm-rubric': evaluateRubric, 'embedding-similarity': evaluateSimilarity,
  };
  const builtins = Object.fromEntries(Object.entries(functions).map(([id, evaluate]) => [id,
    { definition: builtinEvaluatorDefinitions[id]!, evaluate }]));
  for (const id of Object.keys(custom)) {
    if (Object.hasOwn(builtins, id)) throw new Error(`Cannot replace builtin evaluator ${id}`);
  }
  return Object.freeze({ ...builtins, ...custom });
}
