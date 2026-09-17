import type { EvaluationResult } from '../contracts/evaluation.js';

/** Two covers the paired semantic judges of one stage without widening provider fan-out. */
export const defaultCheckConcurrency = 2;
export const maxCheckConcurrency = 8;

export interface StageCheckTask {
  /** Exclusive resources for an independent check; undefined means it must see every earlier result. */
  resources: readonly object[] | undefined;
  run(): Promise<EvaluationResult>;
}

export function checkConcurrency(value: number | undefined): number {
  const limit = value ?? defaultCheckConcurrency;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxCheckConcurrency) throw new Error('Invalid evaluation check concurrency');
  return limit;
}

/**
 * Start independent checks early, but commit every result in declaration order.
 * Dependent checks wait for all earlier commits. Checks start in declaration order
 * and checks sharing a resource never overlap. After a commit fails nothing new
 * starts, and work already started settles before the failure is rethrown.
 */
export async function runStageChecks(tasks: readonly StageCheckTask[], limit: number,
  commit: (value: EvaluationResult, index: number) => Promise<void>): Promise<void> {
  let active = 0;
  const slots: (() => void)[] = [];
  const acquire = async () => {
    if (active < limit) { active++; return; }
    await new Promise<void>(resolve => slots.push(resolve));
  };
  const release = () => {
    const next = slots.shift();
    if (next) next(); else active--;
  };
  const holders = new Map<object, Promise<unknown>>();
  let failure: { error: unknown } | undefined;
  let committed = Promise.resolve();
  let startTurn = Promise.resolve();
  const settle = (index: number, value: Promise<EvaluationResult>) => {
    committed = committed.then(async () => {
      try {
        const evaluated = await value;
        if (!failure) await commit(evaluated, index);
      } catch (error) { failure ??= { error }; }
    });
  };
  for (const [index, task] of tasks.entries()) {
    if (task.resources === undefined || limit === 1) {
      await committed;
      if (failure) break;
      settle(index, task.run());
      await committed;
      continue;
    }
    if (failure) break;
    const blockers = [...new Set(task.resources)].map(resource => holders.get(resource)).filter(value => value !== undefined);
    const previous = startTurn;
    let started!: () => void;
    startTurn = new Promise<void>(resolve => { started = resolve; });
    const running = (async () => {
      try {
        await previous;
        await Promise.all(blockers);
        await acquire();
      } finally { started(); }
      try {
        if (failure) throw new Error('Stage evaluation stopped after an earlier commit failure');
        return await task.run();
      } finally { release(); }
    })();
    const done = running.catch(() => undefined);
    for (const resource of task.resources) holders.set(resource, done);
    settle(index, running);
  }
  // Every started run is awaited by the ordered commit chain, including after a failure.
  await committed;
  if (failure) throw failure.error;
}
