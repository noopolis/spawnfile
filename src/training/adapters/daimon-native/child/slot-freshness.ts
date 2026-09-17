import { randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';

const schema = 'paideia.daimon-native.grok-slot-freshness.v1';
const nonce = z.string().regex(/^[a-f0-9]{64}$/u);
const stateSchema = z.strictObject({ schema: z.literal(schema),
  slots: z.record(z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/u), z.strictObject({ lastGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), pendingNonce: nonce.optional() })) });
type State = z.infer<typeof stateSchema>;

export interface GrokSlotFreshness { expectedNonce: string; minGeneration: number }
/**
 * Evaluator-owned slot recycle freshness, persisted in the caller's experiment state.
 * `request` mints this trial's recycle nonce and the generation floor to write into
 * launch.v2 `broker`; `accept` records a verified receipt so it can never be replayed.
 */
export interface GrokSlotFreshnessStore {
  request(slot: number): Promise<GrokSlotFreshness>;
  accept(slot: number, receipt: { nonce: string; generation: number }): Promise<void>;
}

export function createGrokSlotFreshnessStore(file: string): GrokSlotFreshnessStore {
  if (!isAbsolute(file)) throw new Error('Grok slot freshness state requires an absolute experiment-state path');
  const key = (slot: number): string => {
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Invalid Grok broker slot');
    return String(slot);
  };
  const load = async (): Promise<State> => {
    try { return stateSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema, slots: {} }; throw error; }
  };
  const save = async (state: State): Promise<void> => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => { const next = queue.then(operation); queue = next.catch(() => undefined); return next; };
  return {
    request: slot => serial(async () => {
      const state = await load();
      const entry = state.slots[key(slot)] ?? { lastGeneration: 0 };
      const expectedNonce = randomBytes(32).toString('hex');
      state.slots[key(slot)] = { lastGeneration: entry.lastGeneration, pendingNonce: expectedNonce };
      await save(state);
      return { expectedNonce, minGeneration: entry.lastGeneration + 1 };
    }),
    accept: (slot, receipt) => serial(async () => {
      const state = await load();
      const entry = state.slots[key(slot)];
      if (!entry?.pendingNonce || entry.pendingNonce !== receipt.nonce) throw new Error('Grok slot preflight receipt is stale: nonce');
      if (!Number.isSafeInteger(receipt.generation) || receipt.generation <= entry.lastGeneration) throw new Error('Grok slot preflight receipt is stale: generation');
      state.slots[key(slot)] = { lastGeneration: receipt.generation };
      await save(state);
    }),
  };
}
