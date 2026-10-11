/** Requested calls arrive in output/instance expansion order, after routing decisions. */
export interface EscalationCall { outputId: string; projectionDigest: string }
export interface AdmittedCall extends EscalationCall { admitted: boolean }
export function escalationCallKey(call: EscalationCall): string {
  return JSON.stringify([call.outputId, call.projectionDigest]);
}

/** One admission per requested projection, including forced-teacher requests. */
export function planCallAdmission(calls: readonly EscalationCall[], limit = Infinity): AdmittedCall[] {
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('maxCallsPerTrial: expected positive integer');
  const grouped = new Map<string, AdmittedCall>();
  const admittedPerOutput = new Map<string, number>();
  for (const call of calls) {
    const key = escalationCallKey(call);
    if (grouped.has(key)) continue;
    const count = admittedPerOutput.get(call.outputId) ?? 0;
    const admitted = count < limit;
    grouped.set(key, { ...call, admitted });
    if (admitted) admittedPerOutput.set(call.outputId, count + 1);
  }
  return [...grouped.values()];
}
