import { isDeepStrictEqual } from 'node:util';
import type { TrialReport } from '../trials/index.js';
import { subjectUsageSnapshot } from '../trials/index.js';

/** Verify captured totals without reconstructing usage from observations or invoking a subject. */
export function subjectUsageMatchesNative(report: Pick<TrialReport, 'snapshot' | 'turns' | 'stop' | 'expectedTurns'>): boolean {
  if (!report.snapshot.subjectUsage) return true;
  if (!Number.isSafeInteger(report.expectedTurns) || report.expectedTurns! < 1) return false;
  const captured = subjectUsageSnapshot(report.turns.map(turn => turn.native), { expectedTurns: report.expectedTurns!,
    // This status attests the native boundary before judging. Later evaluator
    // failure can change overall execution/hostWork without changing native usage.
    complete: (report.snapshot.subjectUsage.status === 'complete' || report.snapshot.subjectUsage.settled === true) && report.stop?.state === 'acknowledged' && report.stop.quiescence === 'confirmed' });
  // Captures written before settlement was attested lack the field; they stay unattested.
  if (report.snapshot.subjectUsage.settled === undefined) delete captured.settled;
  return isDeepStrictEqual(report.snapshot.subjectUsage, captured);
}
