import type { InferenceProvider } from '../../contracts/execution.js';
import type { JudgeCall } from '../../contracts/evaluation.js';
import { randomUUID } from 'node:crypto';
import { InferenceFailure } from '../failure.js';
import type { DecisionBackend, DecisionResult } from '../../contracts/grading.js';
import { validateInferenceResponse } from '../response-schema.js';
import { DECISION_PROMPT_VERSION, validateDecisionRequest } from './prompt.js';

export interface TeacherDecisionOptions { provider: InferenceProvider; model: string }

export function createTeacherDecision({ provider, model }: TeacherDecisionOptions): DecisionBackend {
  if (!['claude-subscription', 'grok-subscription', 'codex-subscription'].includes(provider.id) || provider.capabilities.billing !== 'subscription' || provider.capabilities.tools !== (provider.id === 'codex-subscription' ? 'contained' : 'disabled')) {
    throw new Error('Decision teacher requires subscription with native empty-tool attestation or Codex containment');
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
        const started = performance.now();
        const call: JudgeCall = { id: randomUUID(), judge: 'grader-decision', providerId: provider.id,
          requestedModel: model, responseModel: null, responseRoute: null, outcome: 'generation-error', usage: null,
          billing: 'subscription' };
        const receipt = () => { call.wallMs = performance.now() - started; return [call]; };
        try {
          const response = await provider.generate({ model, signal, system: request.system, responseSchema,
            prompt: `${DECISION_PROMPT_VERSION}\nProjection (JSON data):\n${JSON.stringify(request.projection)}\n${request.instructions}\nReturn JSON {${JSON.stringify(request.key)}: option}, where option is one of ${JSON.stringify(labels)} or "abstain".` });
          call.responseModel = response.modelBasis === 'requested-assumption' ? null : response.model;
          call.responseRoute = response.route;
          call.usage = response.usage;
          call.outcome = 'invalid-response';
          validateInferenceResponse(response.text, responseSchema);
          call.outcome = 'completed';
          const answer = (JSON.parse(response.text) as Record<string, string>)[request.key]!;
          results.push(answer === 'abstain'
            ? { key: request.key, status: 'missing', probabilities: null, reason: 'Teacher abstained', teacherAnswered: true, judgeCalls: receipt() }
            : { key: request.key, status: 'ok', probabilities: Object.fromEntries(labels.map(option => [option, Number(answer === option)])), teacherAnswered: true, judgeCalls: receipt() });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof InferenceFailure) {
            call.responseModel = error.responseModel; call.responseRoute = error.responseRoute;
            call.usage = error.usage; call.failureKind = error.kind;
            if (error.detail === 'tool-call') { call.outcome = 'refused'; call.failureDetail = 'tool-call'; }
          }
          results.push({ key: request.key, status: 'missing', probabilities: null, reason: call.outcome === 'refused' ? 'Teacher refused: tool-call' : 'Teacher response missing or invalid', teacherAnswered: true, judgeCalls: receipt() });
        }
      }
      return results;
    },
  };
}
