import type { DecisionRequest, DecisionResult } from '../../../contracts/grading.js';

export function missing(request: DecisionRequest, reason: string): DecisionResult {
  return { key: request.key, status: 'missing', probabilities: null, reason };
}

export function question(request: DecisionRequest) {
  const labels = request.optionLabels.map(String);
  const max = request.type === 'score' ? 10 : request.type === 'yes-no' ? 2 : 255;
  if (!request.key || !request.instructions.trim() || labels.length < 2 || labels.length > max ||
    new Set(labels).size !== labels.length || labels.some(label => !label) ||
    request.type === 'yes-no' && (!labels.includes('yes') || !labels.includes('no'))) {
    throw new Error('Invalid TypeSafe question or option count');
  }
  return { type: request.type === 'yes-no' ? 'noul' : request.type,
    instructions: [request.system, request.instructions].filter(Boolean).join('\n'),
    criteria: request.type === 'score' ? labels.map(label => `Score ${label}`)
      : request.type === 'yes-no' ? { true: 'Yes', false: 'No' }
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
  const answer = raw as { type?: unknown; noul?: unknown; probabilities?: Record<string, unknown> } | null;
  const fail = () => missing(request, 'TypeSafe requires probabilities over every option summing to one');
  if (answer?.type !== (request.type === 'yes-no' ? 'noul' : request.type)) return fail();
  const values = request.type === 'yes-no'
    ? [answer.noul, typeof answer.noul === 'number' ? 1 - answer.noul : undefined]
    : request.optionLabels.map((label, i) => answer.probabilities?.[request.type === 'score' ? String(i) : String(label)]);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) ||
    Math.abs((values as number[]).reduce((sum, value) => sum + value, 0) - 1) > 1e-5) return fail();
  const probabilities = request.type === 'yes-no' ? { yes: values[0] as number, no: values[1] as number }
    : Object.fromEntries(request.optionLabels.map((label, i) => [String(label), values[i] as number]));
  return { key: request.key, status: 'ok', probabilities };
}
