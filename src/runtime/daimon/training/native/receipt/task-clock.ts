import { posix } from 'node:path';
import { z } from 'zod';

/** Daimon's documented environment contract; the optional runtime owns clocked child launches. */
export const nativeTaskClockSchema = z.strictObject({
  origin: z.string().refine(validOrigin, 'Expected valid task clock ISO instant with Z or an explicit offset in UTC years 1970..9999'),
  anchorEpochMs: z.number().int('Expected task clock anchorEpochMs to be a safe integer'),
  libfaketimePath: z.string().min(1).refine(value => !/[\s:\0]/u.test(value) &&
    /^libfaketime[^/]*\.so[^/]*$/u.test(posix.basename(value)), 'Expected a single libfaketime*.so* library path'),
});

export type NativeTaskClock = z.infer<typeof nativeTaskClockSchema>;
export interface NativeTaskClockEvidence {
  version: 'noopolis.task-clock.v1';
  origin: string;
  anchorEpochMs: number;
}

/**
 * Call inside the already-running worker before creating Daimon's host. Setting
 * LD_PRELOAD here supplies Daimon's child gate; it never preloads this worker.
 * Daimon derives tool-only FAKETIME and strips clocks from engine/auth launches.
 */
export function configureNativeTaskClock(
  taskClock: NativeTaskClock | undefined, timeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env, now: () => number = Date.now,
): NativeTaskClockEvidence | undefined {
  if (taskClock === undefined) {
    delete environment.NOOPOLIS_TASK_CLOCK;
    delete environment.LD_PRELOAD;
    return undefined;
  }
  const clock = nativeTaskClockSchema.parse(taskClock);
  const realNow = now();
  if (!Number.isSafeInteger(realNow)) throw new Error('Native task clock validation requires a safe integer real timestamp');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Native task clock requires a positive safe integer trial timeout');
  const { anchorEpochMs } = clock;
  // One caller-owned anchor synchronizes the transport and runtime. Permit only
  // 1 s of clock skew; preparation cannot reuse a previous deadline window.
  if (anchorEpochMs - realNow > 1000) throw new Error('Native task clock anchorEpochMs is more than 1000 ms in the future');
  if (realNow - anchorEpochMs > timeoutMs) throw new Error('Native task clock anchorEpochMs is older than the trial deadline window');
  const evidence: NativeTaskClockEvidence = { version: 'noopolis.task-clock.v1', origin: clock.origin, anchorEpochMs };
  environment.NOOPOLIS_TASK_CLOCK = JSON.stringify(evidence);
  environment.LD_PRELOAD = clock.libfaketimePath;
  return evidence;
}

function validOrigin(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/u.exec(value);
  const epoch = Date.parse(value);
  if (!match || !Number.isSafeInteger(epoch) || epoch < 0 || epoch > 253_402_300_799_999) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}
