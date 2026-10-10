import { expect, it } from 'vitest';
import type { Label, Labels } from '../../graders/index.js';
import { estimateEscalationCost, type EscalationCostCall } from './cost.js';

const call: EscalationCostCall = { outputId: 'a', projectionDigest: 'digest', instanceKeys: ['q', 'r'] };
const attempt = { usage: { inputTokens: 20, outputTokens: 3 }, wall_ms: 100 };
function labels(entries: Record<string, unknown> = {}): Labels {
  const receipt = { instance_keys: ['r', 'q'], projection_digest: 'digest', attempts: [attempt, attempt], ...entries };
  return { schema: 'paideia.labels.v1', grader: 'g', labelers: { c: { kind: 'model', provider: 'claude', model: 'm' } },
    labels: [{ id: 'a', lineage: 'a', output: {}, context: {}, votes: {}, provenance: {
      c: { votes: { q: receipt, r: structuredClone(receipt) } } as Label['provenance'][string] } }] };
}
it('groups by output/projection, counts receipts once and includes repair costs', () => {
  const result = estimateEscalationCost([{ ...call, instanceKeys: ['q'] }, { ...call, instanceKeys: ['r', 'q'] }], labels(), 'c');
  expect(result).toEqual({ outputs: 1, requestedCalls: 1, projectedCalls: 1, overflowCalls: 0, overflowInstances: 0,
    averageCallsPerOutput: 1, matchingCalls: 1, meanInputTokens: 40, meanOutputTokens: 6, meanWallMs: 200,
    estimatedInputTokens: 40, estimatedOutputTokens: 6, estimatedWallMs: 200 });
});
it('applies call limits per output in insertion order and preserves unmatched cost as unknown', () => {
  const result = estimateEscalationCost([call, { ...call, projectionDigest: 'second' }, { ...call, outputId: 'b' }], labels(), 'c', 1);
  expect(result).toMatchObject({ outputs: 2, requestedCalls: 3, projectedCalls: 2, overflowCalls: 1, overflowInstances: 2,
    averageCallsPerOutput: 1, matchingCalls: 1, meanWallMs: 200, estimatedInputTokens: null, estimatedOutputTokens: null, estimatedWallMs: null });
});
it('requires matching projection and complete exact submitted shape, not a subset', () => {
  for (const change of [{ instance_keys: ['q'] }, { instance_keys: ['q', 'r', 's'] }, { projection_digest: 'other' }, { instance_keys: undefined }, { attempts: [] }, { attempts: null }]) {
    expect(estimateEscalationCost([call], labels(change), 'c')).toMatchObject({ matchingCalls: 0, estimatedWallMs: null, meanInputTokens: null });
  }
  expect(estimateEscalationCost([{ ...call, instanceKeys: ['q'] }], labels(), 'c').matchingCalls).toBe(0);
  expect(estimateEscalationCost([call], labels(), 'other').matchingCalls).toBe(0);
  const differing = labels();
  const entries = differing.labels[0]!.provenance.c!.votes as Record<string, Record<string, unknown>>;
  entries.r!.attempts = [attempt];
  expect(estimateEscalationCost([call], differing, 'c').matchingCalls).toBe(0);
  delete entries.r!.attempts;
  expect(estimateEscalationCost([call], differing, 'c').matchingCalls).toBe(0);
});
it('keeps missing, invalid and partial measured dimensions unknown independently', () => {
  for (const bad of [null, {}, { usage: null }, { usage: { inputTokens: -1, outputTokens: '3' }, wall_ms: Infinity }]) {
    expect(estimateEscalationCost([call], labels({ attempts: [bad] }), 'c')).toMatchObject({ matchingCalls: 1,
      estimatedInputTokens: null, estimatedOutputTokens: null, estimatedWallMs: null });
  }
  expect(estimateEscalationCost([call], labels({ attempts: [{ ...attempt, usage: { inputTokens: null, outputTokens: 0 } }] }), 'c'))
    .toMatchObject({ estimatedInputTokens: null, estimatedOutputTokens: 0, estimatedWallMs: 100 });
});
it('handles zero projected calls without claiming measured zero and validates input controls', () => {
  expect(estimateEscalationCost([], labels(), 'c')).toMatchObject({ outputs: 0, averageCallsPerOutput: 0, matchingCalls: 0, estimatedWallMs: null });
  expect(estimateEscalationCost([call], labels(), 'c', 0)).toMatchObject({ projectedCalls: 0, overflowCalls: 1, estimatedWallMs: null });
  for (const maximum of [-1, 0.1, Infinity]) expect(() => estimateEscalationCost([call], labels(), 'c', maximum)).toThrow(/maximum/);
  expect(() => estimateEscalationCost([{ ...call, instanceKeys: [] }], labels(), 'c')).toThrow(/keys/);
});
