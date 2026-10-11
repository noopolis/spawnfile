import { describe, expect, it } from 'vitest';
import { averageAnswers, councilContentDigest, grokWindowOpen, reusableCouncil } from './policy.js';
import type { CouncilOutput } from './types.js';

describe('reference policy', () => {
  it('averages only supplied answer mass without renormalizing missing teachers', () => {
    const result = averageAnswers(['yes', 'no'], [{ answer: 'yes', p: 0.8 }, { answer: 'no' }, { answer: 'abstain' }, { answer: 'missing' }]);
    expect(result.distribution).toEqual({ yes: 0.2, no: 0.25 }); expect(result.unknown_mass).toBe(0.55);
    expect(averageAnswers(['yes'], []).unknown_mass).toBe(1);
  });
  it.each([
    ['2026-10-11T18:29:00Z', false], ['2026-10-11T18:30:00Z', true], ['2026-10-12T04:29:00Z', true],
    ['2026-10-12T04:30:00Z', false], ['2026-12-12T19:30:00Z', true], ['2026-12-12T05:30:00Z', false],
  ])('enforces Berlin overnight boundaries and DST at %s', (at, open) => expect(grokWindowOpen(new Date(at))).toBe(open));
  it('intersects configured windows with the binding Berlin outer window', () => {
    expect(grokWindowOpen(new Date('2026-10-11T10:00:00Z'), { start: '00:00', end: '23:59' })).toBe(false);
    expect(grokWindowOpen(new Date('2026-10-11T21:00:00Z'), { start: '22:00', end: '02:00' })).toBe(true);
    expect(grokWindowOpen(new Date('2026-10-11T19:00:00Z'), { start: '22:00', end: '02:00' })).toBe(false);
    expect(grokWindowOpen(new Date('2026-10-12T03:00:00Z'), { start: '01:00', end: '06:00' })).toBe(true);
    expect(() => grokWindowOpen(new Date(), { start: '09:00', end: '17:00', timeZone: 'UTC' })).toThrow('timezone');
    expect(() => grokWindowOpen(new Date(), { start: '24:01', end: '06:30' })).toThrow('Invalid');
    expect(() => grokWindowOpen(new Date(), { start: '00:00', end: '00:00' })).toThrow('distinct');
  });
  it('rejects stale identities, partial results and corrupted persisted content', () => {
    const content: Omit<CouncilOutput, 'digest'> = { outputDigest: 'a', identity: 'b', complete: true, checks: {}, calls: [], skipped: [] };
    const output = { ...content, digest: councilContentDigest(content) };
    expect(reusableCouncil(output, 'b')).toBe(true);
    expect(reusableCouncil(output, 'c')).toBe(false);
    expect(reusableCouncil({ ...output, outputDigest: 'changed' }, 'b')).toBe(false);
    expect(reusableCouncil({ ...output, complete: false } as unknown as CouncilOutput, 'b')).toBe(false);
  });
});
