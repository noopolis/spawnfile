import { isDeepStrictEqual } from 'node:util';
import { compileJsonSchema } from '../../cases/index.js';
import type { CheckNode } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult } from '../../contracts/evaluation.js';
import { result } from '../logic/index.js';
import { selectEvidence, textReference } from '../selectors.js';

export async function evaluateText(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult> {
  const selected = selectEvidence(check.input as string, context.snapshot);
  if (!selected.found) return result('unknown', `Missing ${String(check.input)}`, context.snapshot.closed);
  let passed: boolean;
  if (check.eval === 'equals') passed = isDeepStrictEqual(selected.value, check.value);
  else if (check.eval === 'contains-any') {
    const strings = typeof selected.value === 'string' ? [selected.value] : selected.value;
    if (!Array.isArray(strings) || strings.some(item => typeof item !== 'string')) {
      return result('error', 'contains-any requires a string or array of strings', context.snapshot.closed);
    }
    passed = strings.some(item => (check.values as string[]).some(value => item.includes(value)));
  } else if (check.eval === 'json-schema') {
    const schemaBytes = typeof check.schema === 'string' ? await context.readText(check.schema) : undefined;
    if (schemaBytes !== undefined) selected.evidence.push(textReference('sidecar', check.schema as string, schemaBytes));
    const schema = schemaBytes === undefined ? check.schema : JSON.parse(schemaBytes);
    const validator = compileJsonSchema(schema);
    passed = validator(selected.value);
  } else throw new Error(`Unknown text evaluator ${check.eval}`);
  return { ...result(passed ? 'pass' : 'fail', `${check.eval}: ${passed ? 'matched' : 'not matched'}`,
    context.snapshot.closed), evidence: selected.evidence, score: passed ? 1 : 0 };
}
