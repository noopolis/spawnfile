import { lstat } from "node:fs/promises";

import { SpawnfileError } from "../shared/index.js";

type RecordReader = (
  file: string,
  links?: readonly number[],
) => Promise<string | null>;

const refuse = (message: string): never => {
  throw new SpawnfileError(
    "runtime_error",
    `Lifecycle completion store refused: ${message}`,
  );
};

export const settleLifecyclePublication = async (
  file: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const info = await lstat(file).catch(() => refuse("publication changed"));
    if (info.nlink === 1) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  refuse("publication did not settle");
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
