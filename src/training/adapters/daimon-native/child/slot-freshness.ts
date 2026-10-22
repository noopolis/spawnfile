import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';

const schema = 'paideia.daimon-native.grok-slot-freshness.v1';
const nonce = z.string().regex(/^[a-f0-9]{64}$/u);
const stateSchema = z.strictObject({ schema: z.literal(schema),
  slots: z.record(z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/u), z.strictObject({ lastGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), pendingNonce: nonce.optional() })) });
type State = z.infer<typeof stateSchema>;
const lockSchema = z.strictObject({ pid: z.number().int().positive(), token: z.string().min(1) });

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
export interface GrokSlotFreshnessOptions { lockTimeoutMs?: number }
interface FreshnessFloors { slots: Record<string, { lastGeneration: number }> }

/** Compare-and-swap guard: a write may never lower any slot's generation floor already on disk. */
export function assertNoFloorRollback(disk: FreshnessFloors, next: FreshnessFloors): void {
  for (const [slot, entry] of Object.entries(disk.slots)) {
    if ((next.slots[slot]?.lastGeneration ?? -1) < entry.lastGeneration) throw new Error('Grok slot freshness state refuses to lower a generation floor');
  }
}

const noFollowRead = constants.O_RDONLY | constants.O_NOFOLLOW;
const exclusiveCreate = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Every operation re-reads the file under an exclusive O_EXCL lockfile shared by all
 * store instances and processes, then compare-and-swaps: no slot's generation floor on
 * disk is ever lowered. A lock whose owner process is gone (same PID namespace) is
 * reclaimed; a live owner is waited for until the lock deadline.
 */
export function createGrokSlotFreshnessStore(file: string, options: GrokSlotFreshnessOptions = {}): GrokSlotFreshnessStore {
  if (!isAbsolute(file)) throw new Error('Grok slot freshness state requires an absolute experiment-state path');
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  const lockFile = `${file}.lock`;
  const key = (slot: number): string => {
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Invalid Grok broker slot');
    return String(slot);
  };
  const refuseLink = async (path: string): Promise<boolean> => {
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Grok slot freshness state must be a private regular file, never a symlink');
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const load = async (): Promise<State> => {
    if (!await refuseLink(file)) return { schema, slots: {} };
    const handle = await open(file, noFollowRead);
    try { return stateSchema.parse(JSON.parse(await handle.readFile('utf8'))); } finally { await handle.close(); }
  };
  const save = async (state: State): Promise<void> => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, exclusiveCreate, 0o600);
    try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); } finally { await handle.close(); }
    await refuseLink(file);
    await rename(temporary, file);
    const directory = await open(dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const acquire = async (): Promise<string> => {
    const token = randomUUID();
    const deadline = Date.now() + lockTimeoutMs;
    for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
      try {
        const handle = await open(lockFile, exclusiveCreate, 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); } finally { await handle.close(); }
        return token;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      let owner: z.infer<typeof lockSchema> | undefined;
      try { owner = lockSchema.parse(JSON.parse(await readFile(lockFile, 'utf8'))); } catch { owner = undefined; }
      if (owner && !alive(owner.pid)) {
        // Reclaim only the exact dead owner's lock: move it aside, then confirm it is still that owner.
        const aside = `${lockFile}.${randomUUID()}.stale`;
        try {
          await rename(lockFile, aside);
          const moved = lockSchema.safeParse(JSON.parse(await readFile(aside, 'utf8')));
          if (moved.success && moved.data.token === owner.token) { await unlink(aside); continue; }
          await rename(aside, lockFile);
        } catch { /* another reclaimer won; retry acquisition */ }
      }
      if (Date.now() >= deadline) throw new Error('Grok slot freshness state lock is held by another live evaluator');
      await pause(delay);
    }
  };
  const release = async (token: string): Promise<void> => {
    const held = lockSchema.safeParse(JSON.parse(await readFile(lockFile, 'utf8')));
    if (held.success && held.data.token === token) await unlink(lockFile);
  };
  const transaction = async <T>(mutate: (state: State) => T): Promise<T> => {
    const token = await acquire();
    try {
      const disk = await load();
      const next = structuredClone(disk);
      const result = mutate(next);
      assertNoFloorRollback(disk, next);
      await save(next);
      return result;
    } finally { await release(token); }
  };
  return {
    request: async slot => {
      const id = key(slot);
      return transaction(state => {
        const entry = state.slots[id] ?? { lastGeneration: 0 };
        const expectedNonce = randomBytes(32).toString('hex');
        state.slots[id] = { lastGeneration: entry.lastGeneration, pendingNonce: expectedNonce };
        return { expectedNonce, minGeneration: entry.lastGeneration + 1 };
      });
    },
    accept: async (slot, receipt) => {
      const id = key(slot);
      await transaction(state => {
        const entry = state.slots[id];
        if (!entry?.pendingNonce || entry.pendingNonce !== receipt.nonce) throw new Error('Grok slot preflight receipt is stale: nonce');
        if (!Number.isSafeInteger(receipt.generation) || receipt.generation <= entry.lastGeneration) throw new Error('Grok slot preflight receipt is stale: generation');
        state.slots[id] = { lastGeneration: receipt.generation };
      });
    },
  };
}
