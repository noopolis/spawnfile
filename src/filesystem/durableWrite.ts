import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

export const syncDirectorySync = (directory: string): void => {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

export const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};

export const syncFileSync = (file: string): void => {
  const fd = openSync(file, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectorySync(path.dirname(file));
};

export const syncFile = async (file: string): Promise<void> => {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
};

/** The rename is visible, but directory durability could not be confirmed. */
export class PublishedFileSyncError extends Error {}

/** The caller creates the parent directory and holds its domain writer lock. */
export const writeDurableFileSync = (file: string, bytes: string): void => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    syncDirectorySync(path.dirname(file));
  } finally { rmSync(temporary, { force: true }); }
};

export const writeDurableFile = async (file: string, bytes: string): Promise<void> => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    try { await syncDirectory(path.dirname(file)); }
    catch (cause) { throw new PublishedFileSyncError(`Published ${file}, but directory fsync failed`, { cause }); }
  } finally { await rm(temporary, { force: true }); }
};
