import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { SpawnfileError } from "../shared/index.js";
import {
  canonicalLifecycleJson,
  lifecycleHeartbeatSchema,
  LIFECYCLE_HEARTBEAT_VERSION,
  type LifecycleHeartbeat,
} from "./lifecycleCompletionContracts.js";
import { LIFECYCLE_LEASE_MS } from "./lifecycleCompletionOwner.js";

const refuse = (message: string): never => {
  throw new SpawnfileError(
    "runtime_error",
    `Lifecycle completion store refused: ${message}`,
  );
};

export const writeLifecycleHeartbeat = async (
  directory: string,
  file: string,
  epoch: string,
  syncDirectory: (directory: string) => Promise<void>,
): Promise<LifecycleHeartbeat> => {
  const heartbeat = lifecycleHeartbeatSchema.parse({
    epoch,
    lease_expires_at: Date.now() + LIFECYCLE_LEASE_MS,
    version: LIFECYCLE_HEARTBEAT_VERSION,
  });
  const final = path.join(directory, file);
  const prior = await lstat(final).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") refuse("unsafe heartbeat");
    return null;
  });
  if (
    prior &&
    (!prior.isFile() ||
      prior.isSymbolicLink() ||
      prior.nlink !== 1 ||
      prior.uid !== (process.getuid?.() ?? -1) ||
      (prior.mode & 0o777) !== 0o600)
  )
    refuse("unsafe heartbeat");
  const temp = path.join(
    directory,
    `.${file}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(
    temp,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalLifecycleJson(heartbeat)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, final);
    await syncDirectory(directory);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return heartbeat;
};
