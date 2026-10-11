import { performance } from 'node:perf_hooks';
import type { InferenceProvider, InferenceResult, InferenceFailureKind } from '../../contracts/execution.js';
import { createClaudeInference, createGrokInference, InferenceFailure } from '../../inference/index.js';
import { stableDigest, type Grader, type Label } from '../../graders/index.js';
import { buildLabelPrompt, decodeLabelVotes, teacherPolicyDigest, type LabelGroup } from '../../graders/labeling/index.js';

type Teacher = Grader['teachers'][number];
export function createGraderTeacher(teacher: Teacher, timeoutMs?: number): InferenceProvider {
  if (teacher.provider === 'claude') {
    if (teacher.effort !== undefined) throw new Error('Claude teacher effort is unsupported');
    return createClaudeInference({ timeoutMs });
  }
  const effort = teacher.effort;
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('Unsupported Grok teacher effort');
  return createGrokInference({ timeoutMs, reasoningEffort: effort as 'low' | 'medium' | 'high' | 'xhigh' | undefined });
}

export async function labelCall(label: Label, group: LabelGroup, teacher: Teacher, provider: InferenceProvider, signal?: AbortSignal): Promise<{ calls: number; votes: number; missing: number; failures: Partial<Record<InferenceFailureKind, number>>; stopped?: InferenceFailureKind }> {
  if (provider.capabilities.billing !== 'subscription' || provider.capabilities.tools !== 'disabled') throw new Error('Teacher requires a tool-free subscription provider');
  const request = buildLabelPrompt(group);
  const attempts: Record<string, unknown>[] = [];
  const failures: Partial<Record<InferenceFailureKind, number>> = {};
  let stopped: InferenceFailureKind | undefined;
  let votes: ReturnType<typeof decodeLabelVotes> = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const at = new Date().toISOString();
    const start = performance.now();
    let result: InferenceResult | undefined;
    let invalid: boolean;
    let failure: InferenceFailure | undefined;
    const prompt = attempt === 0 ? request.prompt : `${request.prompt}\nThe previous response failed the JSON schema. Return exactly the required object with every key, allowed string answers, and no extra keys.`;
    try {
      result = await provider.generate({ model: teacher.model, prompt, system: request.system, responseSchema: request.schema, signal });
      votes = decodeLabelVotes(result.text, group);
      invalid = votes === null;
    } catch (error) {
      signal?.throwIfAborted();
      failure = error instanceof InferenceFailure ? error : undefined;
      invalid = failure?.kind === 'invalid-response';
    }
    const failureKind = votes === null ? failure?.kind ?? (invalid ? 'invalid-response' : 'unknown') : null;
    if (failureKind) failures[failureKind] = (failures[failureKind] ?? 0) + 1;
    if (failureKind && ['authentication', 'auth-stale', 'quota'].includes(failureKind)) stopped = failureKind;
    attempts.push({ failure_kind: failureKind, provider: teacher.provider, requested_model: teacher.model,
      reported_model: result?.modelBasis === 'requested-assumption' ? null : result?.model ?? failure?.responseModel ?? null,
      cli: null, prompt_digest: stableDigest({ system: request.system, prompt, schema: request.schema }),
      at, usage: result?.usage ?? failure?.usage ?? null, wall_ms: performance.now() - start });
    if (votes !== null || !invalid) break;
  }
  const provenance = label.provenance[teacher.id] ??= {};
  const entries = (provenance.votes ??= {}) as Record<string, Label['provenance'][string]>;
  const calls = (provenance.calls ??= {}) as Record<string, Label['provenance'][string]>;
  const receipt = JSON.parse(JSON.stringify({ teacher_policy_digest: teacherPolicyDigest(teacher),
    projection_digest: group.projectionDigest, instance_keys: group.instances.map(({ instance }) => instance.key),
    prompt_digest: request.digest, status: votes ? 'ok' : 'missing', attempts })) as Label['provenance'][string];
  const call = stableDigest(receipt);
  calls[call] = receipt;
  for (const { instance, question } of group.instances) {
    const answers = label.votes[instance.key] ??= {};
    if (votes) answers[teacher.id] = votes[instance.key]!;
    else delete answers[teacher.id];
    entries[instance.key] = { question_digest: stableDigest(question), call };
  }
  return { calls: attempts.length, votes: votes ? group.instances.length : 0, missing: votes ? 0 : group.instances.length, failures, ...(stopped ? { stopped } : {}) };
}
