import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import { EVIDENCE_EXPORT_ERROR } from "./evidenceExportProvider.js";
import type { EvidenceExportPublicationOptions } from "./evidenceExportPublicationTypes.js";

export type { EvidenceExportPublicationOptions } from "./evidenceExportPublicationTypes.js";

export const MAX_BYTES = 65_536;
const fail = (): never => { throw new Error(EVIDENCE_EXPORT_ERROR); };
const validDestinationKey = (value: string | null): value is string => value !== null && /^[0-9a-f]{64}$/u.test(value);

interface DestinationKeySnapshot {
  readonly bytes: string;
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
}

const unlinkOwnedTemporary = async (temporary: string, owned: Pick<DestinationKeySnapshot, "dev" | "ino"> | undefined): Promise<void> => {
  if (!owned) return;
  let current;
  try { current = await lstat(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; return fail(); }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) return fail();
  try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(); }
};

const sync = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
};

const readDestinationKey = async (
  file: string,
  links: readonly number[],
  options?: EvidenceExportPublicationOptions,
  isPending = false,
  includePendingHook = true,
): Promise<DestinationKeySnapshot | null> => {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail();
  }

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    !links.includes(info.nlink) ||
    info.uid !== (process.getuid?.() ?? -1) ||
    info.size > MAX_BYTES ||
    (info.mode & 0o777) !== 0o600
  ) {
    return fail();
  }

  if (isPending && includePendingHook) await options?.afterDestinationKeyPendingLstatBeforeOpen?.();

  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isPending && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail();
  }

  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      !links.includes(current.nlink) ||
      current.uid !== (process.getuid?.() ?? -1) ||
      current.size > MAX_BYTES ||
      (current.mode & 0o777) !== 0o600 ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    ) return fail();

    return Object.freeze({
      bytes: await handle.readFile({ encoding: "utf8" }),
      dev: current.dev,
      ino: current.ino,
      nlink: current.nlink,
    });
  } catch (error) {
    if (isPending && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail();
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export const publishImmutable = async (
  root: string,
  fileName: string,
  content: string,
  joinExisting = false,
  options?: EvidenceExportPublicationOptions,
): Promise<void> => {
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) return fail();
  const file = path.join(root, fileName);

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const prior = await readDestinationKey(file, [1, 2], options);
    if (prior !== null) {
      if (prior.bytes !== content && !joinExisting) return fail();
      if (prior.nlink === 1) return;
      if (prior.nlink === 2) {
        if (options?.afterImmutableTransientRead) await options.afterImmutableTransientRead();
        await sync(root);
        continue;
      }
      return fail();
    }

    const temporary = path.join(root, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    let owned: Pick<DestinationKeySnapshot, "dev" | "ino"> | undefined;
    try {
      await options?.beforeImmutableTempOpen?.(temporary);
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.isSymbolicLink()) return fail();
      owned = { dev: opened.dev, ino: opened.ino };
      await options?.afterImmutableTempIdentity?.(temporary);
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      const info = await handle.stat();
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== (process.getuid?.() ?? -1) || (info.mode & 0o777) !== 0o600 || info.dev !== owned.dev || info.ino !== owned.ino) return fail();
      await handle.close();
      handle = undefined;

      await sync(root);
      await link(temporary, file);
      await sync(root);
      if (options?.afterImmutableFinalLinkBeforeTempUnlink) await options.afterImmutableFinalLinkBeforeTempUnlink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        continue;
      }
      return fail();
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlinkOwnedTemporary(temporary, owned);
      await sync(root);
    }
  }

  return fail();
};

const writeKeyPending = async (
  root: string,
  pending: string,
  options?: EvidenceExportPublicationOptions,
): Promise<DestinationKeySnapshot | null> => {
  const temporary = path.join(root, `.destination-hmac.${process.pid}.${randomUUID()}.tmp`);
  const value = randomBytes(32).toString("hex");

  let handle;
  let identity: Pick<DestinationKeySnapshot, "dev" | "ino"> | undefined;
  let owned: DestinationKeySnapshot | undefined;
  try {
    await options?.beforeDestinationKeyTempOpen?.(temporary);
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink()) return fail();
    identity = { dev: opened.dev, ino: opened.ino };
    await options?.afterDestinationKeyTempIdentity?.(temporary);
    await handle.chmod(0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== (process.getuid?.() ?? -1) || (info.mode & 0o777) !== 0o600 || info.size > MAX_BYTES || info.dev !== identity.dev || info.ino !== identity.ino) return fail();
    await handle.close();
    handle = undefined;
    owned = Object.freeze({ bytes: value, dev: info.dev, ino: info.ino, nlink: info.nlink });

    await sync(root);
    try {
      await link(temporary, pending);
      await sync(root);
      await options?.afterDestinationKeyPendingLinkBeforeTempUnlink?.();
      return owned;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fail();
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    return fail();
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlinkOwnedTemporary(temporary, identity);
    await sync(root);
  }
};

const sameDestinationSnapshot = (left: DestinationKeySnapshot, right: DestinationKeySnapshot): boolean => {
  return left.bytes === right.bytes && left.dev === right.dev && left.ino === right.ino;
};

const destination = async (
  root: string,
  options?: EvidenceExportPublicationOptions,
): Promise<Buffer> => {
  const file = path.join(root, ".destination-hmac.key");
  const pending = path.join(root, ".destination-hmac.pending");
  const validLinks = [1, 2, 3] as const;

  const finalGeneration = async (): Promise<DestinationKeySnapshot | null> => readDestinationKey(file, validLinks, options);
  const pendingGeneration = async (): Promise<DestinationKeySnapshot | null> => readDestinationKey(pending, validLinks, options, true);
  const convergentRead = async (): Promise<DestinationKeySnapshot | null> => readDestinationKey(file, [1, 2, 3], options);

  const unlinkExactDestinationPending = async (snapshot: DestinationKeySnapshot): Promise<boolean> => {
    const current = await readDestinationKey(pending, validLinks, options, true, false);
    if (current === null || !sameDestinationSnapshot(current, snapshot)) return false;
    try {
      await unlink(pending);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      fail();
    }
    await sync(root);
    return true;
  };

  const unlinkOwnedDestinationPending = async (): Promise<boolean> => {
    if (owned === null) return false;
    const removed = await unlinkExactDestinationPending(owned);
    if (removed) owned = null;
    return removed;
  };

  let owned: DestinationKeySnapshot | null = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const currentFinal = await finalGeneration();
    if (currentFinal !== null) {
      if (!validDestinationKey(currentFinal.bytes)) return fail();
      if (options?.afterDestinationKeyFinalSnapshot) await options.afterDestinationKeyFinalSnapshot();

      const staged = await pendingGeneration();
      if (staged === null) {
        const repaired = await convergentRead();
        if (repaired === null || !sameDestinationSnapshot(repaired, currentFinal)) continue;
        if (repaired.nlink === 1) return Buffer.from(repaired.bytes, "hex");
        if (repaired.nlink === 2) continue;
        return fail();
      }

      if (!validDestinationKey(staged.bytes)) return fail();
      if (owned !== null && !sameDestinationSnapshot(owned, staged)) {
        await unlinkExactDestinationPending(owned);
        owned = null;
      }

      if (!sameDestinationSnapshot(staged, currentFinal)) {
        const repaired = await convergentRead();
        if (repaired === null || !sameDestinationSnapshot(repaired, currentFinal)) continue;
        if (repaired.nlink === 1) {
          if (owned !== null) {
            const removed = await unlinkExactDestinationPending(owned);
            if (removed) owned = null;
          }
          continue;
        }
        if (repaired.nlink === 2 || repaired.nlink === 3) continue;
        return fail();
      }

      if (owned === null && staged.nlink !== 3) owned = staged;

      await unlinkOwnedDestinationPending();

      const repaired = await convergentRead();
      if (repaired === null || !sameDestinationSnapshot(repaired, currentFinal)) continue;
      if (repaired.nlink === 1) {
        await options?.afterDestinationKeyRecovered?.();
        return Buffer.from(currentFinal.bytes, "hex");
      }
      if (repaired.nlink === 2 || repaired.nlink === 3) {
        continue;
      }
      return fail();
    }

    if (options?.afterDestinationKeyInitialFinalAbsent) await options.afterDestinationKeyInitialFinalAbsent();
    let staged = await pendingGeneration();
    if (staged === null) {
      const created = await writeKeyPending(root, pending, options);
      if (created === null) continue;
      owned = created;
      staged = created;
    } else {
      if (!validDestinationKey(staged.bytes)) return fail();
      if (staged.nlink === 3) {
        if (owned !== null) {
          const ownedRemoved = await unlinkExactDestinationPending(owned);
          if (ownedRemoved) owned = null;
        }
        continue;
      }
      if (owned === null) {
        owned = staged;
      } else if (!sameDestinationSnapshot(owned, staged)) {
        await unlinkExactDestinationPending(owned);
        owned = null;
      }
    }

    if (owned !== null && (staged.nlink === 1 || staged.nlink === 2)) {
      try {
        await options?.beforeDestinationKeyLink?.();
      } catch {
        return fail();
      }
      const raced = await finalGeneration();
      if (raced !== null) {
        if (!validDestinationKey(raced.bytes) || !sameDestinationSnapshot(raced, owned)) {
          const removed = await unlinkExactDestinationPending(owned);
          if (removed) owned = null;
          continue;
        }

        if (raced.nlink === 1) {
          if (owned !== null) {
            const removed = await unlinkExactDestinationPending(owned);
            if (removed) owned = null;
          }
          return Buffer.from(raced.bytes, "hex");
        }
        if (raced.nlink === 2 || raced.nlink === 3) continue;
        return fail();
      }
    }

    try {
      await link(pending, file);
      await sync(root);
      await options?.afterDestinationKeyPendingLink?.();
      if (owned !== null) {
        try {
          await options?.afterDestinationKeyLinkBeforePendingUnlink?.();
        } catch {
          return fail();
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOENT") return fail();
      if (owned !== null) {
        await unlinkExactDestinationPending(owned);
        owned = null;
      }
      continue;
    }

    const healed = await convergentRead();
    if (healed === null || !sameDestinationSnapshot(healed, staged)) continue;
    if (healed.nlink === 1) {
      if (owned !== null) {
        const removed = await unlinkExactDestinationPending(owned);
        if (removed) owned = null;
      }
      return Buffer.from(healed.bytes, "hex");
    }
    if (healed.nlink === 2 || healed.nlink === 3) {
      if (owned !== null && !sameDestinationSnapshot(owned, healed)) {
        await unlinkExactDestinationPending(owned);
        owned = null;
      }
      continue;
    }

    return fail();
  }

  return fail();
};

export { destination as destinationKey };
