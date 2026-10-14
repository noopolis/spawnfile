import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { TRAINING_TYPESAFE_SECRET_FILE, TRAINING_TYPESAFE_SECRET_INGRESS } from "../container/evaluators.js";
import { DAIMON_ORGANIZATION_UID } from "./paths.js";

/** Root stages into tmpfs before provisioning drops directory ownership and evaluator capabilities. */
export const stageTrainingEvaluatorSecret = async (env: NodeJS.ProcessEnv = process.env): Promise<void> => {
  if (env.PAIDEIA_TYPESAFE_SECRET_FILE === undefined) return;
  if (process.getuid?.() !== 0 || env.PAIDEIA_TYPESAFE_SECRET_FILE !== TRAINING_TYPESAFE_SECRET_FILE) {
    throw Error("Invalid evaluator secret staging declaration");
  }
  try {
    const ingress = path.posix.dirname(TRAINING_TYPESAFE_SECRET_INGRESS);
    const parent = await lstat(ingress);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0) throw Error("Invalid ingress directory");
    // This directory is tmpfs, never the mounted credential inode.
    await chmod(ingress, 0o700);
    const source = await open(TRAINING_TYPESAFE_SECRET_INGRESS, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const info = await source.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 64 * 1024) throw Error("Invalid ingress leaf");
      const buffer = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, 0);
      const after = await source.stat();
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
        throw Error("Secret changed while staging");
      }
      bytes = buffer.subarray(0, bytesRead);
    } finally { await source.close(); }
    const destination = path.posix.dirname(TRAINING_TYPESAFE_SECRET_FILE);
    await mkdir(destination, { mode: 0o700 });
    const target = await open(TRAINING_TYPESAFE_SECRET_FILE,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await target.writeFile(bytes);
      await target.sync();
      await target.chown(DAIMON_ORGANIZATION_UID, DAIMON_ORGANIZATION_UID);
    } finally { bytes.fill(0); await target.close(); }
    await chown(destination, DAIMON_ORGANIZATION_UID, DAIMON_ORGANIZATION_UID);
    const info = await lstat(TRAINING_TYPESAFE_SECRET_FILE), directory = await lstat(destination);
    if (info.uid !== DAIMON_ORGANIZATION_UID || info.gid !== DAIMON_ORGANIZATION_UID || (info.mode & 0o777) !== 0o600 ||
      directory.uid !== DAIMON_ORGANIZATION_UID || directory.gid !== DAIMON_ORGANIZATION_UID || (directory.mode & 0o777) !== 0o700) {
      throw Error("Invalid evaluator secret ownership");
    }
  } catch {
    // Filesystem errors may contain credential bytes supplied by a transport; emit only a fixed diagnostic.
    throw Error("Evaluator secret staging failed");
  }
};
