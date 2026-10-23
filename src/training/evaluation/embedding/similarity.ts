import type { CheckNode } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult } from '../../contracts/evaluation.js';
import { result } from '../logic/index.js';
import { evidenceText, selectEvidence, textReference } from '../selectors.js';

export function cosine(first: readonly number[], second: readonly number[]): number {
  if (!first.length || first.length !== second.length || [...first, ...second].some(value => !Number.isFinite(value))) {
    throw new Error('Embedding vectors require matching nonempty finite dimensions');
  }
  const norm = (values: readonly number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  const denominator = norm(first) * norm(second);
  if (!Number.isFinite(denominator) || denominator === 0) throw new Error('Invalid embedding norm');
  const dot = first.reduce((sum, value, index) => sum + value * second[index]!, 0);
  return Math.max(-1, Math.min(1, dot / denominator));
}

export async function evaluateSimilarity(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult> {
  const selected = selectEvidence(check.input as string, context.snapshot);
  if (!selected.found) return result('unknown', 'Embedding input is missing', context.snapshot.closed);
  const provider = context.embeddings[check.provider as string];
  if (!provider) return result('error', 'Explicit embedding provider is unavailable', context.snapshot.closed);
  const calibrationBytes = await context.readText(check.calibration as string);
  const calibration: unknown = JSON.parse(calibrationBytes);
  if (typeof calibration !== 'object' || calibration === null ||
      (calibration as Record<string, unknown>).model !== check.model ||
      (calibration as Record<string, unknown>).metric !== check.metric ||
      typeof (calibration as Record<string, unknown>).version !== 'string') {
    return result('error', 'Calibration must identify the selected model, metric and version', context.snapshot.closed);
  }
  const reference = await context.readText(check.reference as string);
  const output = await provider.embed([evidenceText(selected.value), reference], check.model as string, context.signal);
  if (output.vectors.length !== 2) throw new Error('Embedding provider returned wrong vector count');
  const similarity = cosine(output.vectors[0]!, output.vectors[1]!);
  return { ...result(similarity >= (check.minimum as number) ? 'pass' : 'fail',
    `Cosine similarity ${similarity}`, context.snapshot.closed), score: (similarity + 1) / 2,
    evidence: [...selected.evidence, textReference('sidecar', check.reference as string, reference),
      textReference('sidecar', check.calibration as string, calibrationBytes)], ...(output.usage ? { usage: [output.usage] } : {}) };
}
