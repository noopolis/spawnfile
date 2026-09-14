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
