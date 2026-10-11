import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stableDigest } from '../../graders/index.js';
import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../contracts/grading.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';

export async function cachedScores(directory: string, backend: DecisionBackend, identity: string,
  requests: readonly DecisionRequest[], concurrency: number, signal?: AbortSignal): Promise<DecisionResult[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  signal?.throwIfAborted();
  const root = join(directory, '.paideia', 'grader-cache');
  await mkdir(root, { recursive: true });
  const file = join(root, `${identity}.jsonl`);
  const cache = new Map<string, DecisionResult>();
  let source = '';
  try { source = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const line of source.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as { digest: string; result: DecisionResult };
    if (typeof row.digest !== 'string' || !row.result || !['ok', 'missing'].includes(row.result.status)) throw new Error('Invalid grader cache entry');
    cache.set(row.digest, row.result);
  }
  const results: DecisionResult[] = new Array(requests.length);
  let next = 0;
  const controller = new AbortController();
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  // Abort at the first worker failure, but drain all scores and writes before returning.
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
    try {
      while (next < requests.length) {
        workSignal.throwIfAborted();
        const index = next++, request = requests[index]!;
        const { key: _key, ...content } = request;
        const digest = stableDigest({ content, identity, prompt: DECISION_PROMPT_VERSION });
        let result = cache.get(digest);
        if (!result) {
          const batch = await backend.score([request], workSignal);
          workSignal.throwIfAborted();
          result = batch.find(item => item.key === request.key);
          if (!result) throw new Error(`Backend omitted result ${request.key}`);
          // Failures are resumable; never turn one transient outage into a permanent cached miss.
          if (result.status === 'ok') {
            cache.set(digest, result);
            await appendFile(file, `${JSON.stringify({ digest, result })}\n`, { mode: 0o600 });
          }
        }
        results[index] = { ...result, key: request.key };
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  }));
  workSignal.throwIfAborted();
  return results;
}
