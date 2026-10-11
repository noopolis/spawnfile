import { randomUUID } from 'node:crypto';
import type { JudgeCall } from '../../contracts/evaluation.js';
import { buildLabelPrompt, decodeLabelVotes, type LabelGroup } from '../labeling/index.js';
import type { GraderTeacher } from './types.js';

/** Grading makes exactly one attempt per projection; failure spends its call slot. */
export async function escalateGroup(group: LabelGroup, teacher: GraderTeacher, name: string, signal?: AbortSignal) {
  if (teacher.provider.capabilities.billing !== 'subscription' || !['disabled', 'contained'].includes(teacher.provider.capabilities.tools)) {
    throw new Error('Escalation teacher requires a tool-isolated subscription provider');
  }
  signal?.throwIfAborted();
  const request = buildLabelPrompt(group);
  const start = performance.now();
  const call: JudgeCall = { id: randomUUID(), judge: name, providerId: teacher.provider.id,
    requestedModel: teacher.model, responseModel: null, responseRoute: null,
    outcome: 'generation-error', usage: null };
  let votes: ReturnType<typeof decodeLabelVotes> = null;
  try {
    const response = await teacher.provider.generate({ model: teacher.model, system: request.system,
      prompt: request.prompt, responseSchema: request.schema, signal });
    call.responseModel = response.modelBasis === 'requested-assumption' ? null : response.model;
    call.responseRoute = response.route;
    call.usage = response.usage;
    votes = decodeLabelVotes(response.text, group);
    call.outcome = votes ? 'completed' : 'invalid-response';
  } catch (error) {
    signal?.throwIfAborted();
    // Neutral provider failures may carry measured evidence; never parse error prose.
    if (error !== null && typeof error === 'object') {
      const failure = error as Partial<Pick<JudgeCall, 'usage' | 'responseModel' | 'responseRoute'>>;
      call.usage = failure.usage ?? null;
      call.responseModel = failure.responseModel ?? null;
      call.responseRoute = failure.responseRoute ?? null;
    }
  }
  call.wallMs = performance.now() - start;
  call.billing = 'subscription';
  return { votes, call };
}
