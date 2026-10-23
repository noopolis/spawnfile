import { expect, it } from 'vitest';
import { evidenceProtocol, citationSchema, citationRepairSchema } from './protocol.js';
import { parseJudgment } from './judgment.js';

it('accepts exact supplied IDs with short grades; schemas also preserve legacy citation and repair shape', () => {
  const protocol = evidenceProtocol({ input: 'text', evidence: 'source' });
  const good = { score: 0.9, verdict: 'pass', reasons: ['Supported.'], evidenceIds: [protocol.packet.units[0]!.id] };
  expect(protocol.parse(JSON.stringify(good))).toEqual({ judgment: good });
  expect(protocol.system).toContain('not truth');
  const citations = [{ source: 'input', quote: 'text' }];
  const original = { ...good, evidenceIds: undefined, citations };
  expect(parseJudgment(JSON.stringify(original), { input: 'text' }).violation).toBeUndefined();
  expect(citationSchema.required).toContain('citations');
  expect(citationRepairSchema.required).toEqual(['citations']);
  expect(() => evidenceProtocol({})).toThrow('empty');
});
it('rejects unknown or repeated IDs, verbose grades, duplicate keys and malformed shape', () => {
  const protocol = evidenceProtocol({ input: 'text' }), id = protocol.packet.units[0]!.id;
  const good = { score: 0.9, verdict: 'pass', reasons: ['Supported.'], evidenceIds: [id] };
  for (const patch of [{ evidenceIds: ['foreign'] }, { evidenceIds: [id, id] }, { evidenceIds: [] },
    { evidenceIds: Array(9).fill(id) }, { score: 2 }, { verdict: 'unknown' }, { reasons: [] },
    { reasons: ['x'.repeat(241)] }, { reasons: ['a', 'b', 'c', 'd'] }, { citations: [] }]) {
    expect(protocol.parse(JSON.stringify({ ...good, ...patch })).violation?.code).toMatch(/^invalid-(?:evidence-ids|judgment)$/u);
  }
  expect(protocol.parse('bad').violation?.code).toBe('invalid-json');
  expect(protocol.parse(`{"score":0,"score":1,"verdict":"pass","reasons":["yes"],"evidenceIds":["${id}"]}`).violation?.code).toBe('invalid-judgment');
  expect(protocol.parse(JSON.stringify({ ...good, evidenceIds: ['foreign'] })).violation?.code).toBe('invalid-evidence-ids');
});
