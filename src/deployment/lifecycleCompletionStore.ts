import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import { LIFECYCLE_RECORD_MAX_BYTES } from "./lifecycleCompletionContracts.js";
import {
  failLifecycleStore,
  resolveLifecycleCompletionDirectory
} from "./lifecycleCompletionPaths.js";
import {
  openLifecycleAuthorityRoot,
  requireLifecycleRootAuthority,
  revalidateHeldLifecycleRoot,
  revalidateLifecycleRootAuthority,
  syncLifecycleDirectory,
  validateLifecycleRoot,
  type LifecycleRootAuthority
} from "./lifecycleCompletionRoot.js";
import {
  matchesSettledLifecyclePublication,
  readSettledLifecycleRecord
} from "./lifecycleCompletionPublication.js";

export {
  admissionPath,
  evidencePath,
  failLifecycleStore,
  heartbeatPath,
  lifecycleRecordName,
  planPath,
  recoveryPath,
  resolveLifecycleCompletionDirectory,
  resolveLifecycleCompletionPath
} from "./lifecycleCompletionPaths.js";
export {
  existingLifecycleRoot,
  lifecycleRoot,
  syncLifecycleDirectory
} from "./lifecycleCompletionRoot.js";

const OWNER = process.getuid?.() ?? -1;

export type LifecycleStoreTestHookPoint =
  | "before_missing_return"
  | "before_record_open"
  | "before_publish_link"
  | "before_publish_temp_open"
  | "before_publish_unlink";

let testHook: ((point: LifecycleStoreTestHookPoint) => Promise<void> | void) | null = null;

export const setLifecycleStoreTestHook = (
  hook: ((point: LifecycleStoreTestHookPoint) => Promise<void> | void) | null
): void => {
  testHook = hook;
};

const runTestHook = async (point: LifecycleStoreTestHookPoint): Promise<void> => {
  await testHook?.(point);
};

const canonicalRecordPath = (file: string, authority: LifecycleRootAuthority): string => {
  const directory = path.dirname(path.resolve(file));
  const configuredRoot = resolveLifecycleCompletionDirectory();
  if (directory !== authority.root && directory !== configuredRoot) {
    failLifecycleStore("unsafe record");
  }
  const base = path.basename(file);
  if (base.includes(path.sep) || base === "." || base === "..") {
    failLifecycleStore("unsafe record");
  }
  return path.join(authority.root, base);
};

export const readLifecycleRecord = async (
  file: string,
  links: readonly number[] = [1]
): Promise<string | null> => {
  const authority = await validateLifecycleRoot(false);
  if (!authority) return null;
  await revalidateLifecycleRootAuthority(authority);
  const exactFile = canonicalRecordPath(file, authority);
  let before;
  try {
    before = await lstat(exactFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await runTestHook("before_missing_return");
      await revalidateLifecycleRootAuthority(authority);
      return null;
    }
    failLifecycleStore("unsafe record");
  }
  if (!before!.isFile() || before!.isSymbolicLink() || before!.uid !== OWNER ||
      before!.size > LIFECYCLE_RECORD_MAX_BYTES || (before!.mode & 0o777) !== 0o600 ||
      !links.includes(before!.nlink)) {
    failLifecycleStore("unsafe record");
  }
  await runTestHook("before_record_open");
  await revalidateLifecycleRootAuthority(authority);
  const handle = await open(exactFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => failLifecycleStore("unsafe record"));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== OWNER || info.size > LIFECYCLE_RECORD_MAX_BYTES ||
        (info.mode & 0o777) !== 0o600 || !links.includes(info.nlink)) {
      failLifecycleStore("unsafe record");
    }
    if (before!.dev !== info.dev || before!.ino !== info.ino) failLifecycleStore("record changed");
    const content = await handle.readFile({ encoding: "utf8" });
    const after = await lstat(exactFile).catch(() => failLifecycleStore("record changed"));
    if (after.dev !== info.dev || after.ino !== info.ino) failLifecycleStore("record changed");
    await revalidateLifecycleRootAuthority(authority);
    return content;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export const publishLifecycleRecord = async (
  directory: string,
  file: string,
  content: string,
  existing: "ignore" | "match" = "match"
): Promise<boolean> => {
  const authority = await requireLifecycleRootAuthority();
  if (path.resolve(directory) !== authority.root) failLifecycleStore("unsafe root");
  const rootHandle = await openLifecycleAuthorityRoot(authority);
  try {
    if (Buffer.byteLength(content) > LIFECYCLE_RECORD_MAX_BYTES) {
      failLifecycleStore("oversize record");
    }
    const final = path.join(authority.root, file);
    if (existing === "match") {
      if (await matchesSettledLifecyclePublication(final, content, readLifecycleRecord)) return false;
    } else if ((await readSettledLifecycleRecord(final, readLifecycleRecord)) !== null) {
      return false;
    }
    const temp = path.join(authority.root, `.${file}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    let linked = false;
    try {
      await runTestHook("before_publish_temp_open");
      await revalidateHeldLifecycleRoot(authority, rootHandle);
      handle = await open(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await runTestHook("before_publish_link");
        await revalidateHeldLifecycleRoot(authority, rootHandle);
        await link(temp, final);
        linked = true;
        await syncLifecycleDirectory(authority.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          failLifecycleStore("publication failed");
        }
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await runTestHook("before_publish_unlink");
      await revalidateHeldLifecycleRoot(authority, rootHandle);
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") failLifecycleStore("publication cleanup failed");
      });
      await syncLifecycleDirectory(authority.root);
    }
    if (!linked && existing === "ignore") {
      if ((await readSettledLifecycleRecord(final, readLifecycleRecord)) === null) {
        failLifecycleStore("publication changed");
      }
      return false;
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const exact = await readLifecycleRecord(final, [1, 2]);
      if (exact !== content) failLifecycleStore("publication changed");
      if ((await lstat(final).catch(() => null))?.nlink === 1) {
        await revalidateHeldLifecycleRoot(authority, rootHandle);
        return linked;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return failLifecycleStore("publication did not settle");
  } finally {
    await rootHandle.close().catch(() => undefined);
  }
};
