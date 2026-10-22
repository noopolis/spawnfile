import type { CheckNode } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult } from '../../contracts/evaluation.js';
import { result } from '../logic/index.js';

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A normalized reward over complete native totals, never an execution budget. */
export async function evaluateTokenEfficiency(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult> {
  const { snapshot } = context;
  const target = check.target_tokens, metric = check.metric;
  if (!count(target) || target === 0 || typeof metric !== 'string' || !['input', 'output', 'total'].includes(metric)) {
    return result('error', 'Invalid token-efficiency parameters', snapshot.closed);
  }
  if (!snapshot.closed) return result('unknown', 'Subject token usage is not final', false);
  const subject = snapshot.subjectUsage;
  if (subject?.status !== 'complete' || !subject.usage) {
    return result('unknown', 'Complete subject token usage is unavailable');
  }
  const usage = subject.usage;
  const values = metric === 'input' ? [usage.inputTokens] : metric === 'output' ? [usage.outputTokens]
    : [usage.inputTokens, usage.outputTokens];
  if (!values.every(count)) return result('unknown', 'Relevant subject token totals are unknown or invalid');
  const measured = values.reduce((sum, value) => sum + value, 0);
  if (!count(measured)) return result('unknown', 'Subject token total exceeds the safe integer range');
  // Ratio form avoids overflowing the denominator; cache/reasoning are subsets.
  return { ...result('pass', `token-efficiency: ${metric} subject tokens=${measured}; reference=${target}`),
    score: 1 / (1 + measured / target) };
}
