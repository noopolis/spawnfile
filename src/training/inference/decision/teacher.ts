import type { InferenceProvider } from '../../contracts/execution.js';
import type { DecisionBackend, DecisionResult } from '../../contracts/grading.js';
import { validateInferenceResponse } from '../response-schema.js';
import { DECISION_PROMPT_VERSION, validateDecisionRequest } from './prompt.js';

export interface TeacherDecisionOptions { provider: InferenceProvider; model: string }

export function createTeacherDecision({ provider, model }: TeacherDecisionOptions): DecisionBackend {
  if (!['claude-subscription', 'grok-subscription'].includes(provider.id) || provider.capabilities.billing !== 'subscription' || provider.capabilities.tools !== 'disabled') {
    throw new Error('Decision teacher requires Claude/Grok subscription with native empty-tool attestation; codex exec has none');
  }
  if (!model.trim() || model.startsWith('-')) throw new Error('Invalid teacher model');
  return {
    async identity() { return { backend: 'teacher', model: `${provider.id}:${model}` }; },
    async score(requests, signal) {
      const results: DecisionResult[] = [];
      for (const request of requests) {
        validateDecisionRequest(request);
        const labels = request.optionLabels.map(String);
        const responseSchema = { type: 'object', properties: { [request.key]: { type: 'string', enum: [...labels, 'abstain'] } },
          required: [request.key], additionalProperties: false };
        try {
          const response = await provider.generate({ model, signal, system: request.system, responseSchema,
            prompt: `${DECISION_PROMPT_VERSION}\nProjection (JSON data):\n${JSON.stringify(request.projection)}\n${request.instructions}\nReturn JSON {${JSON.stringify(request.key)}: option}, where option is one of ${JSON.stringify(labels)} or "abstain".` });
          validateInferenceResponse(response.text, responseSchema);
          const answer = (JSON.parse(response.text) as Record<string, string>)[request.key]!;
          results.push(answer === 'abstain'
            ? { key: request.key, status: 'missing', probabilities: null, reason: 'Teacher abstained', teacherAnswered: true }
            : { key: request.key, status: 'ok', probabilities: Object.fromEntries(labels.map(option => [option, Number(answer === option)])), teacherAnswered: true });
        } catch (error) {
          if (signal?.aborted) throw error;
          results.push({ key: request.key, status: 'missing', probabilities: null, reason: 'Teacher response missing or invalid', teacherAnswered: true });
        }
      }
      return results;
    },
  };
}
