import { expect, it } from 'vitest';
import { validateCachedJudgment } from './schema.js';

const call = {id:'one',judge:'clarity',providerId:'local',requestedModel:'small',responseModel:null,responseRoute:null,
  outcome:'completed',usage:null};
const value = {response:JSON.stringify({score:0.5,verdict:'fail',reasons:['Weak'],citations:[{source:'input',quote:'article'}]}),
  sourceCallId:'one',sourceCalls:[call]};

it('accepts failed grades, retains attempt chains and isolates caller data', () => {
  const fixture = {...value,sourceCallId:'four',sourceCalls:[
    {...call,outcome:'generation-error',failureKind:'quota'},
    {...call,id:'two',outcome:'invalid-response',fallbackOf:'one'},
    {...call,id:'three',outcome:'generation-error',failureKind:'protocol'},
    // A judgement recovered from an aborted call keeps saying so once it is persisted.
    {...call,id:'four',retryOf:'three',retryCause:'provider-error',repairOf:'two',citationRepairs:1},
  ]};
  const validated = validateCachedJudgment(fixture);
  expect(validated).toEqual(fixture);
  validated.sourceCalls![0]!.id = 'mutated';
  expect(fixture.sourceCalls[0]!.id).toBe('one');
});
it.each([
  {...value,sourceCalls:[]}, {...value,sourceCallId:'other'},
  {...value,sourceCalls:[{...call,outcome:'generation-error'}]},
  {...value,sourceCalls:[call,call]},
  {...value,sourceCalls:[{...call,repairOf:'missing'}]},
  {...value,sourceCalls:[{...call,fallbackOf:'missing'}]},
  {...value,sourceCalls:[{...call,retryOf:'missing'}]},
  {...value,sourceCalls:[{...call,retryCause:'not-a-cause'}]},
  {...value,response:'broken'}, {...value,response:'{}'},
  {...value,sourceCalls:[{...call,usage:{inputTokens:-1}}]},
])('rejects malformed or infrastructure evidence %#', invalid => {
  expect(()=>validateCachedJudgment(invalid)).toThrow();
});


const evidenceResponse = { score: 0.84, verdict: 'fail', reasons: ['The quantity is supported; attribution is weak.'],
  evidenceIds: ['e-0123456789abcdef0123', 'e-aaaaaaaaaaaaaaaaaaaa'] };
it('accepts exact evidence-ID responses with native provenance without converting them to citations', () => {
  const evidence = { ...value, response: JSON.stringify(evidenceResponse) };
  expect(validateCachedJudgment(evidence)).toEqual(evidence);
});
it.each([
  { ...evidenceResponse, evidenceIds: [] },
  { ...evidenceResponse, evidenceIds: ['e-0123456789abcdef0123', 'e-0123456789abcdef0123'] },
  { ...evidenceResponse, evidenceIds: Array.from({ length: 9 }, (_, index) => `e-${String(index).padStart(20, '0')}`) },
  { ...evidenceResponse, evidenceIds: ['foreign-id'] },
  { ...evidenceResponse, evidenceIds: ['e-0123456789ABCDEF0123'] },
  { ...evidenceResponse, evidenceIds: [4] },
  { ...evidenceResponse, reasons: [] },
  { ...evidenceResponse, reasons: ['one', 'two', 'three', 'four'] },
  { ...evidenceResponse, reasons: ['x'.repeat(241)] },
  { ...evidenceResponse, citations: [{ source: 'input', quote: 'article' }] },
  { ...evidenceResponse, score: 2 },
  { ...evidenceResponse, verdict: 'error' },
])('rejects malformed, hybrid or out-of-bounds evidence-ID response %#', response => {
  expect(() => validateCachedJudgment({ ...value, response: JSON.stringify(response) })).toThrow('response');
});
it('rejects duplicate JSON keys even when parsing would hide a conflicting field', () => {
  const response = JSON.stringify(evidenceResponse).replace('"score":0.84', '"score":0.2,"score":0.84');
  expect(() => validateCachedJudgment({ ...value, response })).toThrow('response');
});

it('retains measured grader call timing and billing while rejecting invented metadata', () => {
  const enriched = { ...value, sourceCalls: [{ ...call, wallMs: 12.5, billing: 'local' }] };
  expect(validateCachedJudgment(enriched)).toEqual(enriched);
  for (const metadata of [{ wallMs: -1 }, { wallMs: Infinity }, { billing: 'free' }]) {
    expect(() => validateCachedJudgment({ ...value, sourceCalls: [{ ...call, ...metadata }] })).toThrow('provenance');
  }
});
