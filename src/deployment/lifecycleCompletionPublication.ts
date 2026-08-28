import { lstat } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { SpawnfileError } from "../shared/index.js";

type RecordReader = (
  file: string,
  links?: readonly number[],
) => Promise<string | null>;

// A competing publisher removes its temporary hard link asynchronously.  A
// short run of event-loop turns can elapse before that unlink is scheduled
// when many lifecycle operations are active, so leave a bounded but practical
// window before treating an extra link as hostile.
export const LIFECYCLE_PUBLICATION_SETTLE_TIMEOUT_MS = 1_000;
const LIFECYCLE_PUBLICATION_SETTLE_BACKOFF_MS = 2;

const refuse = (message: string): never => {
  throw new SpawnfileError(
    "runtime_error",
    `Lifecycle completion store refused: ${message}`,
  );
};

export const settleLifecyclePublication = async (
  file: string,
): Promise<void> => {
  await settleLifecyclePublicationUntil(async () => {
    const info = await lstat(file).catch(() => refuse("publication changed"));
    return info.nlink === 1;
  });
};

export const settleLifecyclePublicationUntil = async (
  settled: () => Promise<boolean>,
): Promise<void> => {
  const deadline = performance.now() + LIFECYCLE_PUBLICATION_SETTLE_TIMEOUT_MS;
  while (true) {
    if (await settled()) return;
    if (performance.now() >= deadline) refuse("publication did not settle");
    await new Promise<void>((resolve) => setTimeout(resolve, LIFECYCLE_PUBLICATION_SETTLE_BACKOFF_MS));
  }
};

export const readSettledLifecycleRecord = async (
  file: string,
  read: RecordReader,
): Promise<string | null> => {
  const text = await read(file, [1, 2]);
  if (text === null) return null;
  const info = await lstat(file).catch(() => refuse("publication changed"));
  if (info.nlink === 2) {
    await settleLifecyclePublication(file);
    return read(file);
  }
  if (info.nlink !== 1) refuse("unsafe record");
  return text;
};

export const matchesSettledLifecyclePublication = async (
  file: string,
  expected: string,
  read: RecordReader,
): Promise<boolean> => {
  const prior = await readSettledLifecycleRecord(file, read);
  if (prior === null) return false;
  if (prior !== expected) refuse("divergent immutable record");
  return true;
};
