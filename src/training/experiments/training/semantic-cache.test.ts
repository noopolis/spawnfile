import { expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import { createRoutedInference, InferenceFailure } from '../../inference/index.js';
import { evaluationContext, snapshot } from '../../testing/index.js';
import { evaluateRubric } from '../../evaluation/semantic/index.js';
import { createJudgeCache } from '../../evaluation/index.js';

const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: null, source: 'test' };
const check = { judge: 'judge', input: 'output.text', rubric: { prompt: 'Be precise.' }, minimum: 0.8 };
const response = JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Precise'], citations: [{source:'input',quote:'Article'}] });
function fixture() {
  const generate = vi.fn<InferenceProvider['generate']>(async () => ({ text: response, model: 'actual', usage, route: 'local' }));
  const provider: InferenceProvider = { id: 'local', capabilities: { tools: 'disabled', billing: 'local', temperature: false, seed: false }, generate };
  const context = evaluationContext({snapshot: snapshot({output: 'Article'}), judges: {judge: {
    provider, model: 'model', identity: 'policy', cache: createJudgeCache({maxEntries: 10}),
  }}});
  return {generate, provider, context};
}
it('reuses exact valid judgments with provenance and without counting a second call', async () => {
  const f = fixture();
  const first = await evaluateRubric(check, f.context);
  const second = await evaluateRubric(check, f.context);
  expect(first.status).toBe('pass'); expect(second.status).toBe('pass');
  expect(second.cache!.sourceCallId).toBe(first.judgeCalls![0]!.id);
  expect(second.judgeCalls).toEqual([]); expect(second.usage).toBeUndefined();
  expect(f.generate).toHaveBeenCalledTimes(1);
  await evaluateRubric({...check,minimum: 0.95}, f.context);
  expect(f.generate).toHaveBeenCalledTimes(2);
});
it('never caches malformed results or accepts a cache without identity', async () => {
  const f = fixture(); f.generate.mockResolvedValue({text: 'bad', model: 'actual', usage, route: 'local'});
  expect((await evaluateRubric(check, f.context)).status).toBe('error');
  await evaluateRubric(check, f.context); expect(f.generate).toHaveBeenCalledTimes(2);
  f.context.judges.judge!.identity = undefined;
  expect((await evaluateRubric(check, f.context)).reason).toContain('identity');
  expect(f.generate).toHaveBeenCalledTimes(2);
});
it('refuses corrupted cached judgments and honours cancellation before a cache hit', async () => {
  const f = fixture();
  f.context.judges.judge!.cache = {get: () => ({response:'bad',sourceCallId:'x'}),put:()=>undefined};
  expect((await evaluateRubric(check, f.context)).status).toBe('error');
  const controller = new AbortController(); controller.abort(); f.context.signal = controller.signal;
  expect((await evaluateRubric(check, f.context)).status).toBe('error');
  expect(f.generate).not.toHaveBeenCalled();
});
it('retains every fallback attempt and known failed usage, without counting the wrapper', async () => {
  const f = fixture();
  const primary = {...f.provider,id:'primary',generate:async()=>{throw new InferenceFailure('quota','quota',{
    usage,responseModel:'primary-actual',responseRoute:'subscription',
  });}};
  f.context.judges.judge!.provider = createRoutedInference({id:'policy',routes:[{provider:primary,model:'primary'},{provider:f.provider,model:'small'}],maxAttempts:2,timeoutMs:1000});
  const observed = vi.fn(); f.context.observeJudgeAttempt = observed;
  const evaluated = await evaluateRubric(check, f.context);
  expect(evaluated.status).toBe('pass'); expect(evaluated.judgeCalls).toHaveLength(2);
  expect(evaluated.judgeCalls![0]).toMatchObject({failureKind:'quota',usage,responseModel:'primary-actual'});
  expect(evaluated.judgeCalls![1]!.fallbackOf).toBe(evaluated.judgeCalls![0]!.id);
  expect(evaluated.usage).toEqual([usage,usage]); expect(observed).toHaveBeenCalledTimes(2);
});
it('persists exhausted-route metadata and fails closed on its observer failure', async () => {
  const f = fixture();
  const primary = {...f.provider,generate:async()=>{throw new InferenceFailure('quota','quota',{usage});}};
  f.context.judges.judge!.provider = createRoutedInference({id:'policy',routes:[{provider:primary,model:'small'}],maxAttempts:1,timeoutMs:1000});
  f.context.observeJudgeAttempt = () => {throw new Error('PRIVATE DISK ERROR');};
  const evaluated = await evaluateRubric(check, f.context);
  expect(evaluated).toMatchObject({status:'error',reason:'Judge attempt evidence persistence failed',usage:[usage]});
  expect(evaluated.judgeCalls![0]!.failureKind).toBe('quota');
});
it('retains valid failing grades in cache rather than shopping for a pass', async () => {
  const f = fixture(); f.generate.mockResolvedValue({text:response.replace('0.9','0.2').replace('"pass"','"fail"'),model:'actual',route:'local',usage});
  expect((await evaluateRubric(check,f.context)).status).toBe('fail');
  expect((await evaluateRubric(check,f.context)).status).toBe('fail');
  expect(f.generate).toHaveBeenCalledTimes(1);
});
it('renders fixed trusted instructions while retaining a rubric omitted by the template', async () => {
  const f = fixture();
  f.context.judges.judge!.template = {language:'jinja',text:'{% if rubric %}Judge clarity only.{% endif %}'};
  expect((await evaluateRubric(check,f.context)).status).toBe('pass');
  expect(f.generate.mock.calls[0]![0].prompt).toContain('Judge clarity only.\n\nFIXED RUBRIC\nBe precise.');
  f.context.judges.judge!.template.text = '{{ process.exit() }}';
  expect((await evaluateRubric(check,f.context))).toMatchObject({status:'error',reason:'Judge template rendering failed'});
  expect(f.generate).toHaveBeenCalledTimes(1);
});
it('isolates cache identity, selected evidence and rubric changes', async () => {
  const f = fixture();
  await evaluateRubric(check,f.context);
  f.context.judges.judge!.identity = 'changed-policy';
  await evaluateRubric(check,f.context);
  await evaluateRubric({...check,rubric:{prompt:'Check only the lead.'}},f.context);
  f.context.snapshot = snapshot({output:'Article changed'});
  await evaluateRubric(check,f.context);
  expect(f.generate).toHaveBeenCalledTimes(4);
});
it('fails closed when successful fallback evidence cannot be persisted and does not cache it', async () => {
  const f = fixture();
  const primary = {...f.provider,id:'primary',generate:async()=>{throw new InferenceFailure('quota','quota',{usage});}};
  f.context.judges.judge!.provider = createRoutedInference({id:'policy',routes:[{provider:primary,model:'primary'},{provider:f.provider,model:'small'}],maxAttempts:2,timeoutMs:1000});
  const observe = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('PRIVATE WRITE ERROR'));
  f.context.observeJudgeAttempt = observe;
  const evaluated = await evaluateRubric(check,f.context);
  expect(evaluated).toMatchObject({status:'error',reason:'Judge attempt evidence persistence failed',usage:[usage,usage]});
  expect(evaluated.judgeCalls).toHaveLength(2);
  f.context.observeJudgeAttempt = undefined;
  expect((await evaluateRubric(check,f.context)).status).toBe('pass');
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it.each(['quota','transport','unavailable','authentication','protocol','cancelled','timeout','unsupported','unknown'] as const)('preserves a direct provider typed %s failure for bounded recovery policy',async kind=>{
  const f=fixture(); f.generate.mockRejectedValue(new InferenceFailure(kind,'Provider failure'));
  const evaluated=await evaluateRubric(check,f.context);
  expect(evaluated.status).toBe('error');
  expect(evaluated.judgeCalls).toHaveLength(1);
  expect(evaluated.judgeCalls![0]).toMatchObject({outcome:'generation-error',failureKind:kind});
});
it.each([new Error('quota unavailable'),Object.assign(new Error('unknown'),{kind:'invented'}),'quota'])('does not infer retry classification from arbitrary error prose %#',async error=>{
  const f=fixture(); f.generate.mockRejectedValue(error);
  const evaluated=await evaluateRubric(check,f.context);
  expect(evaluated.status).toBe('error'); expect(evaluated.judgeCalls![0]!.failureKind).toBeUndefined();
});
