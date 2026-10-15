import type { TrialReport } from '../trials/index.js';

export interface TrialRetry {
  failedTrialId: string;
  replacementTrialId: string;
  cause: string;
  attempt: number;
}

/** Sequential replacements stay inside the original callback/held-out worker. */
export async function retryTrial(input: {
  key: string;
  maximum: number;
  signal?: AbortSignal;
  execute(key: string, retry?: Omit<TrialRetry, 'replacementTrialId'>): Promise<TrialReport>;
}): Promise<TrialReport> {
  let report = await input.execute(input.key);
  for (let attempt = 1; report.execution === 'failed' && attempt <= input.maximum; attempt++) {
    input.signal?.throwIfAborted();
    // An abandoned native process must never overlap its replacement.
    if (report.hostWork !== 'settled' || report.stop?.state !== 'acknowledged' || report.stop.quiescence !== 'confirmed') break;
    const retry = { failedTrialId: report.id, cause: report.error ?? 'Native infrastructure failure', attempt };
    report = await input.execute(`trial-retry:${JSON.stringify([input.key, attempt])}`, retry);
  }
  return report;
}
