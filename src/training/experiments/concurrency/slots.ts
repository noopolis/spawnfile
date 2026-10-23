import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { TrialSlot } from '../../contracts/trial-slot.js';

const slotSchema = z.object({
  index: z.number().int().min(0).max(7),
  workerUid: z.number().int().positive().max(4_294_967_294),
  roots: z.record(z.string().min(1), z.string().refine(isAbsolute)),
  ports: z.object({ base: z.number().int().min(1024).max(65535), count: z.number().int().positive() }).strict(),
}).strict();
const sharedUidSlotSchema = slotSchema.extend({ isolation: z.literal('shared-uid') });
const provisionedSlotSchema = z.union([slotSchema, sharedUidSlotSchema]);
const slotsDocumentSchema = z.discriminatedUnion('schema', [
  z.object({ schema: z.literal('spawnfile.training-slots.v1'), slots: z.array(slotSchema).min(1).max(8) }).strict(),
  z.object({ schema: z.literal('spawnfile.training-slots.v2'), slots: z.array(sharedUidSlotSchema).min(1).max(8) }).strict(),
]);
export const trialConcurrency = (value: number): number => z.number().int().min(1).max(8).parse(value);

export async function loadTrialSlots(options: { concurrency?: number; slotsFile?: string; slots?: readonly TrialSlot[] } = {}) {
  if (options.concurrency !== undefined) trialConcurrency(options.concurrency);
  let slots: readonly TrialSlot[] | undefined = options.slots;
  if (!slots) {
    const path = options.slotsFile ?? '/run/paideia/slots.json';
    try {
      const info = await stat(path);
      if ((info.mode & 0o222) !== 0) throw new Error('Trial slot descriptor file must be read-only');
      const document = slotsDocumentSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      slots = document.slots;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.slotsFile) throw error;
    }
  }
  if (!slots) {
    if ((options.concurrency ?? 1) > 1) throw new Error('Concurrent trials require provisioned slot descriptors');
    return { concurrency: 1, pool: undefined, slots: undefined };
  }
  const parsed = z.array(provisionedSlotSchema).min(1).max(8).parse(slots);
  for (const [i, slot] of parsed.entries()) {
    const sharedUid = 'isolation' in slot && slot.isolation === 'shared-uid';
    if (slot.ports.base + slot.ports.count > 65536 || !sharedUid && !Object.keys(slot.roots).length) throw new Error('Invalid slot roots or port block');
    for (const prior of parsed.slice(0, i)) {
      const sharedIdentity = sharedUid && 'isolation' in prior && prior.isolation === 'shared-uid';
      if (prior.index === slot.index || prior.workerUid === slot.workerUid && !sharedIdentity ||
          prior.ports.base < slot.ports.base + slot.ports.count && slot.ports.base < prior.ports.base + prior.ports.count) {
        throw new Error('Slot indices, worker identities and port blocks must be disjoint');
      }
    }
  }
  const concurrency = options.concurrency ?? parsed.length;
  if (concurrency > parsed.length) throw new Error('Trial concurrency exceeds provisioned slots');
  return { concurrency, pool: new SlotPool(parsed.slice(0, concurrency)), slots: parsed };
}

/** Resolve an offset from the descriptor supplied to native preparation. */
export function slotPort(slot: TrialSlot, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= slot.ports.count) throw new RangeError('Port index is outside the leased block');
  return slot.ports.base + index;
}

/** `cause` says why an unconfirmed release quarantines the slot; exhaustion errors name every recorded cause. */
export interface SlotLease { slot: TrialSlot; port(index: number): number; release(confirmed: boolean, cause?: string): void }
interface Waiter { resolve(lease: SlotLease): void; reject(error: Error): void; signal?: AbortSignal; abort(): void }

export class SlotPool {
  private readonly free: TrialSlot[];
  private readonly waiting: Waiter[] = [];
  private usable: number;
  private readonly quarantined: string[] = [];
  constructor(slots: readonly TrialSlot[]) {
    if (!slots.length) throw new Error('No usable trial slots remain');
    this.free = structuredClone([...slots]);
    this.usable = slots.length;
  }
  acquire(signal?: AbortSignal): Promise<SlotLease> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.usable) return Promise.reject(this.exhausted());
    const slot = this.free.shift();
    if (slot) return Promise.resolve(this.lease(slot));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(signal!.reason);
      } };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  private lease(slot: TrialSlot): SlotLease {
    let released = false;
    return { slot: structuredClone(slot), port: index => slotPort(slot, index), release: (confirmed, cause) => {
      if (released) throw new Error('Trial slot lease already released');
      released = true;
      if (confirmed) this.free.push(slot);
      else { this.usable -= 1; this.quarantined.push(`slot ${slot.index}: ${cause?.trim().slice(0, 300) || 'closure unconfirmed'}`); }
      while (this.waiting.length && (this.free.length || !this.usable)) {
        const waiter = this.waiting.shift()!;
        waiter.signal?.removeEventListener('abort', waiter.abort);
        if (!this.usable) waiter.reject(this.exhausted());
        else waiter.resolve(this.lease(this.free.shift()!));
      }
      if (!this.usable) throw this.exhausted();
    } };
  }
  private exhausted(): Error {
    return new Error(`No usable trial slots remain; all slots quarantined (${this.quarantined.join('; ')})`);
  }
}
