import type { DecisionRequest } from '../../contracts/grading.js';

// v3 refuses input truncation. Regenerate calibration; v1/v2 raw scores may
// contain optimistic bounds or silently truncated prompts and cannot be reused.
export const DECISION_PROMPT_VERSION = 'paideia.grader-prompt.v3';
export const DECISION_LETTERS = 'ABCDEFGHIJKLMNOP';

export function validateDecisionRequest(request: DecisionRequest): void {
  const labels = request.optionLabels.map(String);
  if (labels.length < 2 || labels.length > 16 || new Set(labels).size !== labels.length ||
    labels.some(label => !label.length) || !request.key.length || !request.instructions.trim()) throw new Error('Invalid decision request');
  if (request.expectedOptions?.some(option => !labels.includes(String(option)))) throw new Error('Invalid expected options');
}

/** The projection is data; neither expected options nor any historical answer is rendered. */
export function decisionPrompt(request: DecisionRequest): string {
  return `${DECISION_PROMPT_VERSION}\nProjection (JSON data):\n${JSON.stringify(request.projection)}\nQuestion:\n${request.instructions}\nOptions:\n${
    request.optionLabels.map((option, i) => `${DECISION_LETTERS[i]}: ${JSON.stringify(option)}`).join('\n')}\nAnswer with one letter`;
}
