import { describe, expect, it } from 'vitest';
import { deriveConsensus } from './consensus.js';
import type { Label, Labels } from './format/index.js';
const labelers: Labels['labelers'] = {
  a: { kind: 'model', provider: 'claude', model: 'm' }, b: { kind: 'model', provider: 'claude', model: 'm' },
  c: { kind: 'model', provider: 'grok', model: 'm' }, h: { kind: 'human', name: 'H' }, j: { kind: 'human', name: 'J' },
};
function label(votes: Label['votes'], asked?: string[]): Label {
  return { id: 'l', lineage: 'g', output: {}, context: {}, provenance: {}, votes, asked };
}
describe('consensus', () => {
  it('counts abstaining and missing asked teachers against strict majority', () => {
    expect(deriveConsensus(label({ q: { a: 'yes', b: 'abstain' } }), labelers).q?.disputed).toBe(true);
    expect(deriveConsensus(label({ q: { a: 'yes' } }, ['a', 'b']), labelers).q?.disputed).toBe(true);
    expect(deriveConsensus(label({ q: { a: 'yes' }, other: { b: 'yes' } }), labelers).q?.disputed).toBe(true);
    expect(deriveConsensus(label({ q: { a: 'yes', b: 'yes', c: 'abstain' } }), labelers).q).toMatchObject({ answer: 'yes', source: 'consensus', disputed: false });
  });
  it('records single teacher, no vote and human override including conflicts', () => {
    expect(deriveConsensus(label({ q: { a: 3 } }), labelers).q).toMatchObject({ answer: 3, source: 'single-teacher', votes: { a: 3 } });
    expect(deriveConsensus(label({}, ['a']), labelers, ['q']).q).toMatchObject({ disputed: true, source: 'single-teacher' });
    expect(deriveConsensus(label({ q: { a: 'yes', b: 'yes', h: 'no' } }), labelers).q).toMatchObject({ answer: 'no', source: 'human' });
    expect(deriveConsensus(label({ q: { h: 'yes', j: 'no' } }), labelers).q).toMatchObject({ disputed: true, source: 'human' });
    expect(deriveConsensus(label({ q: { a: 'yes', h: 'abstain' } }), labelers).q).toMatchObject({ answer: 'yes', source: 'single-teacher' });
    expect(deriveConsensus(label({ q: {} }), labelers).q).toMatchObject({ disputed: true, source: 'consensus' });
    expect(deriveConsensus(label({ q: { absent: 'yes' } }), labelers).q?.disputed).toBe(true);
  });
});
