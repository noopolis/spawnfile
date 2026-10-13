import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { acquireTrainingGrokWritebackLock } from "./trainingGrokWritebackLock.js";

const failure = (): Error => Error("Training Grok credential writeback failed");
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Reads only private, bounded, canonical leaves. Errors never include credential bytes. */
export const readTrainingGrokLeaf = async (file: string): Promise<Buffer> => {
  if (await realpath(file) !== path.resolve(file)) throw failure();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n || before.size < 2n || before.size > 65536n) throw failure();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(length) !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      bytes.fill(0); throw failure();
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
};

const expiry = (bytes: Buffer): number => {
  try {
    const rows = Object.entries(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>)
      .filter(([key]) => /^https:\/\/auth\.x\.ai::/u.test(key)).map(([, value]) => value as Record<string, unknown>);
    const row = rows[0];
    if (rows.length !== 1 || typeof row?.key !== "string" || !row.key.trim() || typeof row.refresh_token !== "string" || !row.refresh_token.trim() || typeof row.expires_at !== "string") throw failure();
    const value = Date.parse(row.expires_at);
    if (!Number.isFinite(value)) throw failure();
    return value;
  } catch { throw failure(); }
};

/** A settled journal proves rotation; native expiry orders credentials across independent realms. */
export const writeBackTrainingGrokCredential = async (profile: string, candidate: string, journalFile: string): Promise<boolean> => {
  const release = await acquireTrainingGrokWritebackLock(profile, 30_000).catch(() => { throw failure(); });
  const temporary = path.join(path.dirname(profile), `.grok-writeback-${randomUUID()}`);
  let current: Buffer | undefined, renewed: Buffer | undefined, journalBytes: Buffer | undefined;
  try {
    current = await readTrainingGrokLeaf(profile);
    renewed = await readTrainingGrokLeaf(candidate);
    if (digest(current) === digest(renewed)) return false;
    journalBytes = await readTrainingGrokLeaf(journalFile);
    const journal = JSON.parse(journalBytes.toString("utf8")) as Record<string, unknown>;
    if (journal.version !== "noopolis.daimon.broker-credential-journal.v1" || journal.state !== "promoted" ||
      !Number.isSafeInteger(journal.generation) || (journal.generation as number) < 1 ||
      typeof journal.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(journal.sourceDigest) || journal.promotedDigest !== digest(renewed)) throw failure();
    const renewedExpiry = expiry(renewed), currentExpiry = expiry(current);
    const ancestors = journal.ancestorDigests ?? [];
    if (!Array.isArray(ancestors) || ancestors.length > 900 || ancestors.some((entry) => typeof entry !== "string" || !/^[a-f0-9]{64}$/u.test(entry))) throw failure();
    if (renewedExpiry < currentExpiry || (renewedExpiry === currentExpiry && journal.sourceDigest !== digest(current) && !ancestors.includes(digest(current)))) return false;
    const identity = await lstat(profile, { bigint: true });
    const output = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(renewed); await output.sync(); } finally { await output.close(); }
    // Import and writeback hold the same lock through publication. This check
    // also detects non-cooperating edits made before validation, not after it.
    const check = await readTrainingGrokLeaf(profile);
    try {
      const now = await lstat(profile, { bigint: true });
      if (digest(check) !== digest(current) || now.ino !== identity.ino || now.dev !== identity.dev || now.ctimeNs !== identity.ctimeNs) throw failure();
    } finally { check.fill(0); }
    await rename(temporary, profile);
    const directory = await open(path.dirname(profile), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  } catch { throw failure(); }
  finally {
    current?.fill(0); renewed?.fill(0); journalBytes?.fill(0);
    try { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    finally { release(); }
  }
};
