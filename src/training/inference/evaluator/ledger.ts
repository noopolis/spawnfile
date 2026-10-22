import { appendFileSync, constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { evaluatorRoute, routeKey, type EvaluatorPurpose } from './policy.js';

const receipt = z.object({ version: z.literal('paideia.evaluator-request.v1'), id: z.string().uuid(),
  policy: z.string().regex(/^[a-f0-9]{64}$/u), route: z.string(),
  event: z.enum(['admitted', 'completed', 'failed']), at: z.string().datetime(),
  reservedUsd: z.number().finite().nonnegative(), chargedUsd: z.number().finite().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
}).strict();
export type EvaluatorReceipt = z.infer<typeof receipt>;
export function reserveEvaluatorRequest(provider: string, purpose: EvaluatorPurpose, model: string, estimatedUsd = 0) {
  const selected = evaluatorRoute(provider, purpose, model), route = routeKey(selected.route);
  const policy = createHash('sha256').update(JSON.stringify(selected.route)).digest('hex');
  if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) throw Error('Invalid evaluator spend estimate');
  // Synchronous append and fsync serialize concurrent admission in the single evaluator process.
  // The admission survives interruption; missing completions keep their conservative charge.
  const fd = openSync(selected.receiptPath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw Error('Invalid evaluator receipt ledger');
    const bytes = readFileSync(fd, 'utf8');
    const previous = bytes === '' ? [] : bytes.trimEnd().split('\n').map(line => receipt.parse(JSON.parse(line)));
    const owned = previous.filter(item => item.route === route);
    if (owned.some(item => item.policy !== policy)) throw Error('Evaluator budget changed on resume');
    const calls = new Map<string, EvaluatorReceipt>();
    for (const item of owned) {
      if (item.event === 'admitted') {
        if (calls.has(item.id)) throw Error('Duplicate evaluator admission');
      } else if (calls.get(item.id)?.event !== 'admitted') throw Error('Invalid evaluator completion');
      calls.set(item.id, item);
    }
    const spent = [...calls.values()].reduce((sum, item) => sum + Math.max(item.reservedUsd, item.chargedUsd), 0);
    if (calls.size >= selected.route.maxRequests) throw Error('Evaluator request cap exhausted');
    if (selected.route.maxSpendUsd === 0 || (selected.route.maxSpendUsd !== undefined && spent + estimatedUsd > selected.route.maxSpendUsd)) {
      throw Error('Evaluator spend cap exhausted');
    }
    const admitted: EvaluatorReceipt = { version: 'paideia.evaluator-request.v1', id: randomUUID(), policy, route,
      event: 'admitted', at: new Date().toISOString(), reservedUsd: estimatedUsd, chargedUsd: 0, inputTokens: null, outputTokens: null };
    appendFileSync(fd, `${JSON.stringify(admitted)}\n`); fsyncSync(fd);
    return { id: admitted.id,
      finish(outcome: 'completed' | 'failed', accounting?: { inputTokens?: number | null; outputTokens?: number | null; usd?: number | null }) {
        const count = (value: number | null | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
        const usd = accounting?.usd;
        const completed = { ...admitted, event: outcome, at: new Date().toISOString(),
          chargedUsd: typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : 0,
          inputTokens: count(accounting?.inputTokens), outputTokens: count(accounting?.outputTokens) };
        const target = openSync(selected.receiptPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
        try { appendFileSync(target, `${JSON.stringify(completed)}\n`); fsyncSync(target); }
        finally { closeSync(target); }
      },
    };
  } finally { closeSync(fd); }
}
