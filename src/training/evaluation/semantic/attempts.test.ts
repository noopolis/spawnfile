import { expect, it } from 'vitest';
import { directFailureEvidence } from './attempts.js';

it('projects only attributable named fields from a direct typed failure and isolates mutation',()=>{
  const error=Object.assign(new Error('PRIVATE provider detail'),{kind:'protocol',responseModel:'actual',responseRoute:'local',
    usage:{inputTokens:2445,cachedInputTokens:null,outputTokens:1651,reasoningTokens:22,source:'provider',
      cacheWriteInputTokens:4,cacheWrite5mInputTokens:3,cacheWrite1hInputTokens:1,thinking:'HIDDEN'},text:'TRUNCATED'});
  const projected=directFailureEvidence(error);
  expect(projected).toEqual({failureKind:'protocol',responseModel:'actual',responseRoute:'local',usage:{
    inputTokens:2445,cachedInputTokens:null,outputTokens:1651,reasoningTokens:22,source:'provider',
    cacheWriteInputTokens:4,cacheWrite5mInputTokens:3,cacheWrite1hInputTokens:1}});
  projected.usage!.inputTokens=0;expect(error.usage.inputTokens).toBe(2445);
  expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|HIDDEN|TRUNCATED/);
});
it('keeps independently valid counters and rejects malformed or unattributed accounting',()=>{
  const error=Object.assign(new Error('failure'),{kind:'quota',responseModel:42,responseRoute:' ',
    usage:{inputTokens:10,cachedInputTokens:-1,outputTokens:'bad',reasoningTokens:1.5,cacheWriteInputTokens:Infinity,source:'provider'}});
  expect(directFailureEvidence(error)).toEqual({failureKind:'quota',responseModel:null,responseRoute:null,
    usage:{inputTokens:10,cachedInputTokens:null,outputTokens:null,reasoningTokens:null,cacheWriteInputTokens:null,source:'provider'}});
  for(const usage of [null,undefined,[],{},'raw',{source:''},{source:3}]) {
    expect(directFailureEvidence(Object.assign(new Error('failure'),{kind:'quota',usage})).usage).toBeNull();
  }
  expect(directFailureEvidence(new Error('quota'))).toEqual({});
});

it('projects only finite bounded protected diagnostic fields from typed failures', async () => {
  const { directFailureDiagnostic } = await import('./attempts.js');
  const error = (diagnostic: unknown) => Object.assign(new Error('private'), { kind: 'invalid-response', diagnostic });
  const hash = 'sha256:' + 'a'.repeat(64);
  expect(directFailureDiagnostic(error({ code: 'transport-framing', extra: 'omit' }))).toEqual({ code: 'transport-framing' });
  expect(directFailureDiagnostic(error({ code: 'response-schema', response: { bytes: 1, sha256: hash, omitted: false, text: 'x', extra: 'omit' } })))
    .toEqual({ code: 'response-schema', response: { bytes: 1, sha256: hash, omitted: false, text: 'x' } });
  expect(directFailureDiagnostic(error({ code: 'response-schema', response: { bytes: 65_537, sha256: hash, omitted: true } })))
    .toEqual({ code: 'response-schema', response: { bytes: 65_537, sha256: hash, omitted: true } });
  for (const value of [null, {}, { code: 'invented' }, { code: 'tool-isolation', response: {} },
    { code: 'response-schema', response: null }, { code: 'response-schema', response: { bytes: NaN } },
    ...[{ bytes: -1 }, { bytes: 1.5 }, { sha256: 'bad' }, { bytes: 2 }, { text: 5 }, { omitted: true },
      { omitted: false, bytes: 65_537, text: 'x'.repeat(65_537) }].map(patch => ({ code: 'response-schema', response: { bytes: 1, sha256: hash, omitted: false, text: 'x', ...patch } }))]) {
    expect(directFailureDiagnostic(error(value))).toBeUndefined();
  }
  expect(directFailureDiagnostic(new Error('unknown'))).toBeUndefined();
  expect(directFailureDiagnostic(Object.assign(new Error('typed without evidence'), { kind: 'protocol' }))).toBeUndefined();
});
