import { stableDigest, type Labels } from '../../graders/index.js';

export interface EscalationCostCall { outputId: string; projectionDigest: string; instanceKeys: string[] }
export interface EscalationCostEstimate {
  /** Outputs represented by requested escalation calls, not all dataset outputs. */
  outputs: number;
  requestedCalls: number;
  projectedCalls: number;
  overflowCalls: number;
  overflowInstances: number;
  averageCallsPerOutput: number;
  matchingCalls: number;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  meanWallMs: number | null;
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  estimatedWallMs: number | null;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const sumKnown = (values: unknown[]): number | null => values.length && values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  ? (values as number[]).reduce((sum, value) => sum + value, 0) : null;

/** Descriptive estimate only: missing receipts and unmatched call shapes never imply zero cost. */
export function estimateEscalationCost(calls: readonly EscalationCostCall[], labels: Labels, teacherId: string,
  maxCallsPerTrial = Number.MAX_SAFE_INTEGER): EscalationCostEstimate {
  if (!Number.isSafeInteger(maxCallsPerTrial) || maxCallsPerTrial < 0) throw new Error('Invalid maximum escalation calls');
  const grouped = new Map<string, EscalationCostCall>();
  for (const call of calls) {
    if (!call.instanceKeys.length) throw new Error('Escalation cost requires instance keys');
    const key = JSON.stringify([call.outputId, call.projectionDigest]);
    const existing = grouped.get(key);
    grouped.set(key, { ...call, instanceKeys: [...new Set([...(existing?.instanceKeys ?? []), ...call.instanceKeys])].sort() });
  }
  const perOutput = new Map<string, number>();
  const admitted: EscalationCostCall[] = [];
  let overflowInstances = 0;
  for (const call of grouped.values()) {
    const count = perOutput.get(call.outputId) ?? 0;
    perOutput.set(call.outputId, count + 1);
    if (count < maxCallsPerTrial) admitted.push(call);
    else overflowInstances += call.instanceKeys.length;
  }
  const measurements = admitted.flatMap(call => {
    const label = labels.labels.find(label => label.id === call.outputId);
    const votes = object(label?.provenance[teacherId]?.votes);
    const entries = call.instanceKeys.map(key => object(votes?.[key]));
    if (entries.some(entry => !entry || entry.projection_digest !== call.projectionDigest ||
      !Array.isArray(entry.instance_keys) || stableDigest([...entry.instance_keys].sort()) !== stableDigest(call.instanceKeys))) return [];
    const attempts = entries[0]!.attempts;
    if (!Array.isArray(attempts) || !attempts.length || entries.some(entry => !Array.isArray(entry!.attempts) || stableDigest(entry!.attempts) !== stableDigest(attempts))) return [];
    return [{ input: sumKnown(attempts.map(attempt => object(object(attempt)?.usage)?.inputTokens)),
      output: sumKnown(attempts.map(attempt => object(object(attempt)?.usage)?.outputTokens)),
      wall: sumKnown(attempts.map(attempt => object(attempt)?.wall_ms)) }];
  });
  const summarize = (field: 'input' | 'output' | 'wall') => {
    const total = sumKnown(measurements.map(measurement => measurement[field]));
    return { mean: total === null ? null : total / measurements.length,
      estimate: measurements.length === admitted.length ? total : null };
  };
  const input = summarize('input'), output = summarize('output'), wall = summarize('wall');
  return { outputs: perOutput.size, requestedCalls: grouped.size, projectedCalls: admitted.length,
    overflowCalls: grouped.size - admitted.length, overflowInstances,
    averageCallsPerOutput: perOutput.size ? admitted.length / perOutput.size : 0,
    matchingCalls: measurements.length, meanInputTokens: input.mean, meanOutputTokens: output.mean, meanWallMs: wall.mean,
    estimatedInputTokens: input.estimate, estimatedOutputTokens: output.estimate, estimatedWallMs: wall.estimate };
}
