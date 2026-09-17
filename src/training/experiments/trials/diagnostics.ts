import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubjectStartupCapture, SubjectStartupDiagnostic } from '../../contracts/execution.js';

const streams = (value: Record<string, unknown>): boolean => {
  if (value.streams === undefined) return value.redaction === 'withheld';
  const row = value.streams as Record<string, unknown>;
  const flags = row.truncated as Record<string, unknown> | undefined;
  return value.redaction === 'applied' && typeof row.stdout === 'string' && typeof row.stderr === 'string' &&
    !!flags && typeof flags.stdout === 'boolean' && typeof flags.stderr === 'boolean';
};

const detectorName = /^[a-z][a-z-]{0,31}$/u;
const frames = (value: Record<string, unknown>): boolean => {
  if (value.frames === undefined) return true;
  if (!Array.isArray(value.frames) || value.frames.length > 32) return false;
  return value.frames.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const frame = row as Record<string, unknown>;
    return ['stdout', 'stderr'].includes(String(frame.stream)) && typeof frame.schema === 'string' && !!frame.schema &&
      (frame.message === undefined || typeof frame.message === 'string') &&
      (frame.withheldBy === undefined || Array.isArray(frame.withheldBy) && frame.withheldBy.every(name => detectorName.test(String(name))));
  });
};
const withheld = (value: Record<string, unknown>): boolean => {
  if (value.withheld === undefined) return true;
  if (!Array.isArray(value.withheld) || value.withheld.length > 2) return false;
  return value.withheld.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const entry = row as Record<string, unknown>;
    // A withheld stream must always say which detector fired; an unexplained withhold is the defect this closes.
    return ['stdout', 'stderr'].includes(String(entry.stream)) && Number.isSafeInteger(entry.bytes) && Number.isSafeInteger(entry.lines) &&
      (entry.frame === null || typeof entry.frame === 'string' && !!entry.frame) &&
      Array.isArray(entry.detectors) && entry.detectors.length > 0 && entry.detectors.every(name => detectorName.test(String(name)));
  });
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
    !['applied', 'withheld'].includes(String(row.redaction)) || !optionalString('protectedArtifact') ||
    !optionalString('operatorCapture') || !streams(row) || !frames(row) || !withheld(row)) return undefined;
  return value as SubjectStartupDiagnostic;
}

const basename = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** The unredacted capture an adapter hands over exactly once, if it published one at all. */
export function subjectStartupCapture(caught: unknown): SubjectStartupCapture | undefined {
  if (!caught || typeof caught !== 'object' || !('capture' in caught)) return undefined;
  const value = (caught as { capture: unknown }).capture;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.basename !== 'string' || !basename.test(row.basename) || typeof row.content !== 'string' || !row.content) return undefined;
  return { basename: row.basename, content: row.content };
}

/**
 * Writes the adapter's full capture to the operator's own trial directory.
 *
 * The protected/published boundary this repository enforces is the audience of a
 * shipped artifact — viewer projections, reports, optimizer and model inputs —
 * not the existence of bytes on the operator's disk. An adapter's control root
 * can be runtime-local storage that dies with its container, which leaves a
 * failure with no account anywhere. This file closes that: `0600`, named so it
 * announces itself, written beside the trial's own scratch rather than into the
 * content store, so no replay, projection or report can reach it. Only its path
 * enters the durable record.
 */
export async function writeOperatorCapture(root: string, capture: SubjectStartupCapture): Promise<string | undefined> {
  const file = join(root, capture.basename);
  try { await writeFile(file, capture.content, { flag: 'wx', mode: 0o600 }); return file; }
  catch { return undefined; }
}
