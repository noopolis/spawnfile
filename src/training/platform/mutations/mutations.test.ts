import { expect, it } from 'vitest';
import { MutationQueue } from './index.js';

it('serializes read/await/write transactions and recovers after a rejected transaction', async () => {
  const queue = new MutationQueue();
  const values: number[] = [];
  await Promise.all(Array.from({ length: 20 }, (_, index) => queue.run(async () => {
    const snapshot = [...values];
    await Promise.resolve();
    values.splice(0, values.length, ...snapshot, index);
  })));
  expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
  await expect(queue.run(() => { throw new Error('refused'); })).rejects.toThrow('refused');
  expect(await queue.run(() => 42)).toBe(42);
});
