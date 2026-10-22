import type { DecisionRequest, DecisionResult } from '../../../contracts/grading.js';

export function missing(request: DecisionRequest, reason: string, failureCause?: DecisionResult['failureCause']): DecisionResult {
  return { key: request.key, status: 'missing', probabilities: null, reason, ...(failureCause ? { failureCause } : {}) };
}

export function question(request: DecisionRequest) {
  const labels = request.optionLabels.map(String);
  const noul = request.type === 'yes-no' || request.type === 'noul';
  const max = request.type === 'score' ? 10 : noul ? 2 : 255;
  if (!request.key || !request.instructions.trim() || labels.length < 2 || labels.length > max ||
    new Set(labels).size !== labels.length || labels.some(label => !label) ||
    request.type === 'yes-no' && (!labels.includes('yes') || !labels.includes('no')) ||
    request.type === 'noul' && (!labels.includes('true') || !labels.includes('false'))) {
    throw new Error('Invalid TypeSafe question or option count');
  }
  return { type: noul ? 'noul' : request.type,
    instructions: [request.system, request.instructions].filter(Boolean).join('\n'),
    criteria: request.type === 'score' ? labels.map(label => `Score ${label}`)
      : noul ? { true: 'Yes', false: 'No' }
      : Object.fromEntries(labels.map(label => [label, label])) };
}

export function payload(model: string, requests: DecisionRequest[]) {
  return { model, state: JSON.stringify(requests[0]!.projection),
    questions: Object.fromEntries(requests.map(request => [request.key, question(request)])) };
}

/** Includes JSON framing, repeated state and full question instructions. */
export function estimatedTokens(model: string, requests: DecisionRequest[]): number {
  return Math.ceil(JSON.stringify(payload(model, requests)).length / 3);
}

export function decode(request: DecisionRequest, raw: unknown): DecisionResult {
  const noul = request.type === 'yes-no' || request.type === 'noul';
  const answer = raw as { type?: unknown; noul?: unknown; probabilities?: Record<string, unknown> } | null;
  const fail = () => missing(request, 'TypeSafe requires probabilities over every option with total in [0.97, 1.03]');
  if (answer?.type !== (noul ? 'noul' : request.type)) return fail();
  const values = noul
    ? [answer.noul, typeof answer.noul === 'number' ? 1 - answer.noul : undefined]
    : request.optionLabels.map((label, i) => answer.probabilities?.[request.type === 'score' ? String(i) : String(label)]);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) return fail();
  const total = (values as number[]).reduce((sum, value) => sum + value, 0);
  const tolerance = Number.EPSILON * values.length;
  if (total < 0.97 - tolerance || total > 1.03 + tolerance) return fail();
  const normalized = (values as number[]).map(value => value / total);
  const probabilities = noul ? request.type === 'yes-no'
    ? { yes: normalized[0]!, no: normalized[1]! } : { true: normalized[0]!, false: normalized[1]! }
    : Object.fromEntries(request.optionLabels.map((label, i) => [String(label), normalized[i]!]));
  return { key: request.key, status: 'ok', probabilities, providerRounded: true };
}
