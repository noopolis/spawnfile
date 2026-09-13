import { describe, expect, it } from 'vitest';
import { observation } from '../testing/index.js';
import { captureObservation, capturedCalls, completeToolScope, happensBefore } from './index.js';

describe('trusted native observations', () => {
  it('deduplicates exact retransmissions, rejecting altered identity and cross-trial input', () => {
    const first = observation();
    const events = captureObservation([], first);
    first.args = 'changed outside capture';
    expect(events[0]!.args).toEqual({ value: 'article' });
    expect(captureObservation(events, observation())).toEqual(events);
    expect(() => captureObservation(events, first)).toThrow('Conflicting event');
    expect(() => captureObservation(events, observation({ id: 'new' }))).toThrow('sequence');
    expect(() => captureObservation(events, observation({ trialId: 'other' }))).toThrow('Cross-trial');
    for (const patch of [{ id: '' }, { source: '' }, { trialId: '' }, { wakeId: '' }, { seq: -1 },
      { seq: 0.5 }, { timestamp: 'invalid' }]) expect(() => captureObservation([], observation(patch))).toThrow('Malformed');
  });
  it('joins out-of-order completion to dispatch and retains unsuccessful calls', () => {
    const end = observation({ id: 'end', seq: 2, type: 'tool.complete', success: false, result: 'invalid' });
    const calls = capturedCalls([end, observation(), observation({ id: 'text', seq: 3, type: 'output' })]);
    expect(calls[0]).toMatchObject({ id: 'call', success: false, result: 'invalid', args: { value: 'article' } });
    expect(() => capturedCalls([observation({ callId: undefined })])).toThrow('identity');
    expect(() => capturedCalls([observation(), observation({ tool: 'file' })])).toThrow('lineage');
    expect(() => capturedCalls([observation(), observation()])).toThrow('dispatch');
    expect(() => capturedCalls([end, end])).toThrow('completion');
  });
  it('uses native ordering and explicit causality, never wall timestamps or arrival', () => {
    const first = observation();
    const second = observation({ id: 'second', seq: 2 });
    const coverage = [{ channel: 'tools' as const, completeness: 'partial' as const, ordering: 'source' as const }];
    expect(happensBefore(first, second, [second, first], coverage)).toBe(true);
    expect(happensBefore(second, first, [first, second], coverage)).toBe(false);
    expect(happensBefore(first, first, [], coverage)).toBe(false);
    expect(happensBefore(first, second, [], [])).toBeUndefined();
    expect(happensBefore(first, second, [first, second], [...coverage,
      { channel: 'tools', completeness: 'partial', ordering: 'none' }])).toBeUndefined();
    const middle = observation({ id: 'middle', source: 'other', causalParents: [first.id] });
    const remote = observation({ id: 'remote', source: 'remote', causalParents: ['middle'] });
    expect(happensBefore(first, remote, [middle, remote], [])).toBe(true);
    expect(happensBefore(first, remote, [], [])).toBeUndefined();
    middle.causalParents = ['middle'];
    expect(happensBefore(first, remote, [middle], [])).toBeUndefined();
    expect(happensBefore(first, observation({ id: 'other', source: 'other' }), [], [])).toBeUndefined();
  });
  it('requires closed and complete tool scope before certifying absence', () => {
    expect(completeToolScope(true, [])).toBe(false);
    expect(completeToolScope(false, [{ channel: 'tools', completeness: 'complete', ordering: 'none' }])).toBe(false);
    expect(completeToolScope(true, [{ channel: 'tools', completeness: 'partial', ordering: 'none' }])).toBe(false);
    expect(completeToolScope(true, [{ channel: 'tools', completeness: 'complete', ordering: 'none' }])).toBe(true);
  });
});
