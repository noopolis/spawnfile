import { expect, it } from 'vitest';
import { subjectStartupDiagnostic } from './diagnostics.js';

const valid = { schema: 'paideia.daimon-native.startup-diagnostic.v1', trialId: 'trial', reason: 'worker exited',
  exitCode: 1, exitSignal: null, redaction: 'applied' as const,
  streams: { stdout: '', stderr: 'boom', truncated: { stdout: false, stderr: false } }, protectedArtifact: '/run/x.json' };

it('accepts the documented adapter record, with or without published streams', () => {
  expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: valid }))).toEqual(valid);
  const withheld = { ...valid, redaction: 'withheld' as const, streams: undefined };
  expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: withheld }))?.redaction).toBe('withheld');
});

it('refuses anything that is not that record, so the runner never stores a shape it cannot read', () => {
  const cases: unknown[] = [undefined, null, 'error', new Error('plain'),
    Object.assign(new Error('x'), { diagnostic: null }),
    Object.assign(new Error('x'), { diagnostic: [valid] }),
    ...(['schema', 'trialId', 'reason', 'exitCode', 'exitSignal', 'redaction'] as const)
      .map(key => Object.assign(new Error('x'), { diagnostic: { ...valid, [key]: undefined } })),
    Object.assign(new Error('x'), { diagnostic: { ...valid, reason: '' } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, exitCode: 1.5 } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, redaction: 'partial' } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, protectedArtifact: 7 } }),
    // Streams must be complete when claimed, and absent when redaction was withheld.
    Object.assign(new Error('x'), { diagnostic: { ...valid, streams: { stdout: '', stderr: '' } } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, streams: { stdout: '', stderr: '', truncated: { stdout: false } } } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, redaction: 'withheld' } }),
  ];
  for (const value of cases) expect(subjectStartupDiagnostic(value)).toBeUndefined();
});
