import type { SubjectStartupDiagnostic } from '../../contracts/execution.js';

const streams = (value: Record<string, unknown>): boolean => {
  if (value.streams === undefined) return value.redaction === 'withheld';
  const row = value.streams as Record<string, unknown>;
  const flags = row.truncated as Record<string, unknown> | undefined;
  return value.redaction === 'applied' && typeof row.stdout === 'string' && typeof row.stderr === 'string' &&
    !!flags && typeof flags.stdout === 'boolean' && typeof flags.stderr === 'boolean';
};

/**
 * The adapter-published record of a subject that never became ready.
 *
 * The runner stays runtime-neutral: it never imports an adapter, so it accepts
 * this structurally from the thrown error and refuses anything that is not the
 * documented shape. An adapter that publishes nothing simply has no diagnostic,
 * and the trial's own error message remains the only account of the failure.
 */
export function subjectStartupDiagnostic(caught: unknown): SubjectStartupDiagnostic | undefined {
  if (!caught || typeof caught !== 'object' || !('diagnostic' in caught)) return undefined;
  const value = (caught as { diagnostic: unknown }).diagnostic;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const optionalString = (key: string): boolean => row[key] === undefined || typeof row[key] === 'string';
  if (typeof row.schema !== 'string' || !row.schema || typeof row.trialId !== 'string' || typeof row.reason !== 'string' || !row.reason ||
    !(row.exitCode === null || Number.isSafeInteger(row.exitCode)) || !(row.exitSignal === null || typeof row.exitSignal === 'string') ||
    !['applied', 'withheld'].includes(String(row.redaction)) || !optionalString('protectedArtifact') || !streams(row)) return undefined;
  return value as SubjectStartupDiagnostic;
}
