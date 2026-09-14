import { expect, it } from 'vitest';
import { validateCachedJudgment } from './schema.js';

const call = {id:'one',judge:'clarity',providerId:'local',requestedModel:'small',responseModel:null,responseRoute:null,
  outcome:'completed',usage:null};
const value = {response:JSON.stringify({score:0.5,verdict:'fail',reasons:['Weak'],citations:[{source:'input',quote:'article'}]}),
  sourceCallId:'one',sourceCalls:[call]};

it('accepts failed grades, retains attempt chains and isolates caller data', () => {
  const fixture = {...value,sourceCallId:'three',sourceCalls:[
    {...call,outcome:'generation-error',failureKind:'quota'},
    {...call,id:'two',outcome:'invalid-response',fallbackOf:'one'},
    {...call,id:'three',repairOf:'two',citationRepairs:1},
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
  {...value,response:'broken'}, {...value,response:'{}'},
  {...value,sourceCalls:[{...call,usage:{inputTokens:-1}}]},
])('rejects malformed or infrastructure evidence %#', invalid => {
  expect(()=>validateCachedJudgment(invalid)).toThrow();
});
