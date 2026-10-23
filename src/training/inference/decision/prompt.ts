import { GRADER_CACHE_PROMPT_DOMAIN } from '../../contracts/index.js';
import type { DecisionRequest } from '../../contracts/grading.js';

// v4 fingerprints Jev input preparation. Regenerate calibration; earlier scores
// cannot distinguish servers that truncate inputs from servers that refuse them.
// The actual model prompt and cache domain share the historical protocol version.
export const DECISION_PROMPT_VERSION = GRADER_CACHE_PROMPT_DOMAIN;
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
