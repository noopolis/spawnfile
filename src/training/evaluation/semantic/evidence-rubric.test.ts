import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { InferenceRequest } from '../../contracts/execution.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';
import { createJudgeCache, evaluateRubric } from './index.js';
const check = { eval: 'llm-rubric', input: 'artifact:article', evidence: 'input:files', judge: 'narrow',
  rubric: { prompt: 'Judge only the supported quantity.' }, minimum: 0.9 };
function fixture() {
  const generate = vi.fn(async (request: InferenceRequest) => {
    const packet = JSON.parse(request.prompt.split('SOURCE DATA\n')[1]!) as { units: { id: string }[] };
    return { text: JSON.stringify({ score: 0.8, verdict: 'pass', reasons: ['A quantity lacks support.'], evidenceIds: [packet.units[0]!.id] }),
      model: 'actual', route: 'local', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null, source: 'test' } };
  });
  const observe = vi.fn();
  const context = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact({ body: 'Claim.' }) } }),
    judges: { narrow: { provider: { id: 'local', capabilities: { tools: 'disabled', billing: 'local', temperature: true, seed: true }, generate },
      model: 'small', protocol: 'evidence-ids', identity: 'fixed', cache: createJudgeCache({ maxEntries: 5 }) } }, observeJudgeAttempt: observe });
  return { context, generate, observe };
}
it('uses native schema, retains fixed rubric and hard floor, caches only validated IDs', async () => {
  const f = fixture(), result = await evaluateRubric(check, f.context);
  expect(result).toMatchObject({ status: 'fail', score: 0.8, usage: [{ inputTokens: 100, outputTokens: 20 }] });
  const request = f.generate.mock.calls[0]![0];
  expect(request.responseSchema).toMatchObject({ required: ['score', 'verdict', 'reasons', 'evidenceIds'] });
  expect(request.prompt).toContain(check.rubric.prompt);
  expect(request.system).not.toContain('exact substring');
  expect(f.observe).toHaveBeenCalledTimes(1);
  expect((await evaluateRubric(check, f.context)).cache).toBeDefined();
  expect(f.generate).toHaveBeenCalledTimes(1);
});
it('rejects bad IDs without another generation, preserves usage and does not cache failure', async () => {
  const f = fixture();
  f.generate.mockResolvedValue({ text: '{"score":0.99,"verdict":"pass","reasons":["yes"],"evidenceIds":["wrong"]}',
    model: 'actual', route: 'local', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null, source: 'test' } });
  const result = await evaluateRubric(check, f.context);
  expect(result.status).toBe('error'); expect(result.score).toBeUndefined(); expect(result.usage).toHaveLength(1);
  expect(f.generate).toHaveBeenCalledTimes(1); expect(f.observe.mock.calls[0]![0].violation.code).toBe('invalid-evidence-ids');
  await evaluateRubric(check, f.context); expect(f.generate).toHaveBeenCalledTimes(2);
});
it('fails before cognition on unsupported protocol/repair and oversized evidence', async () => {
  const f = fixture(); const route = f.context.judges.narrow!;
  route.citationRepairs = 1; expect((await evaluateRubric(check, f.context)).reason).toContain('do not support');
  route.citationRepairs = 0; route.protocol = 'other' as 'evidence-ids';
  expect((await evaluateRubric(check, f.context)).reason).toContain('Unsupported');
  route.protocol = 'evidence-ids'; f.context.snapshot = snapshot({ artifacts: { article: artifact('🙂'.repeat(65536)) } });
  expect((await evaluateRubric(check, f.context)).reason).toContain('bounded packet'); expect(f.generate).not.toHaveBeenCalled();
});

it('hits a pre-rename evidence-ID judgment without changing current request or source bytes', async () => {
  const f = fixture();
  await evaluateRubric(check, f.context);
  const request = f.generate.mock.calls[0]![0];
  const [prefix, data] = request.prompt.split('SOURCE DATA\n');
  const packet = JSON.parse(data!);
  expect(packet.schema).toBe('spawnfile.training.evidence-units.v1');
  const oldPrompt = `${prefix}SOURCE DATA\n${JSON.stringify({ ...packet, schema: 'paideia.evidence-units.v1' })}`;
  // Exact pre-rename key formula from origin/main, independent of frozen constants.
  const oldKey = `sha256:${createHash('sha256').update(JSON.stringify([
    'paideia.judgment-cache.v3', '', 'fixed', request.system, oldPrompt, check.minimum,
  ])).digest('hex')}`;
  const cache = createJudgeCache({ maxEntries: 5 });
  cache.put(oldKey, { response: (await f.generate.mock.results[0]!.value).text, sourceCallId: 'pre-rename-paid' });
  f.context.judges.narrow!.cache = cache;
  f.generate.mockClear();
  expect(await evaluateRubric(check, f.context)).toMatchObject({ status: 'fail', cache: { sourceCallId: 'pre-rename-paid' } });
  expect(f.generate).not.toHaveBeenCalled();
  f.context.snapshot = snapshot({ artifacts: { article: artifact({ body: 'spawnfile.training.evidence-units.v1' }) } });
  await evaluateRubric(check, f.context);
  expect(f.generate).toHaveBeenCalledTimes(1);
  const changed = JSON.parse(f.generate.mock.calls[0]![0].prompt.split('SOURCE DATA\n')[1]!);
  expect(changed.schema).toBe('spawnfile.training.evidence-units.v1');
  expect(changed.units.some((unit: { value: unknown }) => unit.value === 'spawnfile.training.evidence-units.v1')).toBe(true);
});
