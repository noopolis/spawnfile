import { createHash, type Hash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

import { SpawnfileError } from "../shared/index.js";

/** Bumped whenever the bytes this writer emits for the same entries change. */
export const WORKSPACE_BUNDLE_TAR_WRITER = "spawnfile.workspace-bundle-tar.v1";
/** Same bounds the prebuilt-tar staging path enforces. */
export const WORKSPACE_BUNDLE_MAX_BYTES = 536_870_912;
export const WORKSPACE_BUNDLE_MAX_ENTRIES = 65_536;

const BLOCK = 512;
const FLUSH_BYTES = 1_048_576;

export type BundleFileMode = 0o644 | 0o755;

/** Git records one bit of mode: executable or not. Every emitted mode collapses to one of two values. */
export const normalizeBundleMode = (rawMode: number): BundleFileMode => (rawMode & 0o111) ? 0o755 : 0o644;

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;

/** Splits a path across the ustar prefix (155 bytes) and name (100 bytes) fields, or refuses it. */
export const splitUstarPath = (name: string): { base: Buffer; prefix: Buffer } => {
  const raw = Buffer.from(name, "utf8");
  if (raw.length <= 100) return { base: raw, prefix: Buffer.alloc(0) };
  for (let index = name.indexOf("/"); index > 0; index = name.indexOf("/", index + 1)) {
    const prefix = Buffer.from(name.slice(0, index), "utf8"), base = Buffer.from(name.slice(index + 1), "utf8");
    if (prefix.length <= 155 && base.length <= 100 && base.length > 0) return { base, prefix };
  }
  return fail(`Workspace bundle path exceeds ustar bounds: ${name}`);
};

/** One deterministic ustar header: uid/gid 0, mtime 0, owner root, regular file. */
export const ustarHeader = (name: string, size: number, mode: BundleFileMode): Buffer => {
  const bytes = Buffer.alloc(BLOCK), { base, prefix } = splitUstarPath(name);
  base.copy(bytes, 0);
  bytes.write(octal(mode, 8), 100, "ascii");
  bytes.write(octal(0, 8), 108, "ascii");
  bytes.write(octal(0, 8), 116, "ascii");
  bytes.write(octal(size, 12), 124, "ascii");
  bytes.write(octal(0, 12), 136, "ascii");
  bytes.fill(0x20, 148, 156);
  bytes[156] = 0x30;
  bytes.write("ustar\0", 257, "ascii");
  bytes.write("00", 263, "ascii");
  bytes.write("root", 265, "ascii");
  bytes.write("root", 297, "ascii");
  prefix.copy(bytes, 345);
  let sum = 0;
  for (const byte of bytes) sum += byte;
  bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return bytes;
};

export interface BundleTarSummary {
  contentBytes: number;
  fileCount: number;
  sha256: `sha256:${string}`;
  size: number;
}

/**
 * Streams entries into a tar file while hashing it. Callers add entries in
 * sorted path order; the writer refuses an unsorted or duplicate path so two
 * builds of the same entry set cannot disagree on order.
 */
export class BundleTarWriter {
  private readonly hash: Hash = createHash("sha256");
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private size = 0;
  private contentBytes = 0;
  private fileCount = 0;
  private remaining = 0;
  private currentSize = 0;
  private lastPath: string | undefined;

  private readonly handle: FileHandle;

  private constructor(handle: FileHandle) {
    this.handle = handle;
  }

  static async create(filePath: string): Promise<BundleTarWriter> {
    return new BundleTarWriter(await open(filePath, "wx", 0o600));
  }

  async begin(name: string, size: number, mode: BundleFileMode): Promise<void> {
    if (this.remaining !== 0) fail("Workspace bundle entry was not fully written");
    if (this.lastPath !== undefined && name <= this.lastPath) fail(`Workspace bundle entries are not in strict path order: ${name}`);
    this.fileCount += 1;
    if (this.fileCount > WORKSPACE_BUNDLE_MAX_ENTRIES) fail("Workspace bundle exceeds the maximum entry count");
    this.contentBytes += size;
    // Header, padded content and the two-block terminator must all fit.
    if (this.size + BLOCK + Math.ceil(size / BLOCK) * BLOCK + BLOCK * 2 > WORKSPACE_BUNDLE_MAX_BYTES) fail("Workspace bundle exceeds the maximum archive size");
    this.lastPath = name;
    this.remaining = size;
    this.currentSize = size;
    await this.push(ustarHeader(name, size, mode));
  }

  async data(chunk: Buffer): Promise<void> {
    if (chunk.length > this.remaining) fail("Workspace bundle input grew while it was archived");
    this.remaining -= chunk.length;
    await this.push(chunk);
  }

  async end(): Promise<void> {
    if (this.remaining !== 0) fail("Workspace bundle input shrank while it was archived");
    const padding = (BLOCK - (this.currentSize % BLOCK)) % BLOCK;
    if (padding) await this.push(Buffer.alloc(padding));
  }

  async finish(): Promise<BundleTarSummary> {
    try {
      if (this.remaining !== 0) fail("Workspace bundle entry was not fully written");
      if (this.fileCount === 0) fail("Workspace bundle has no input files");
      await this.push(Buffer.alloc(BLOCK * 2));
      await this.flush();
      await this.handle.sync();
    } finally {
      await this.handle.close();
    }
    return { contentBytes: this.contentBytes, fileCount: this.fileCount, sha256: `sha256:${this.hash.digest("hex")}`, size: this.size };
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }

  private async push(chunk: Buffer): Promise<void> {
    this.hash.update(chunk);
    this.size += chunk.length;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= FLUSH_BYTES) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.pendingBytes === 0) return;
    const buffer = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    for (let offset = 0; offset < buffer.length;) {
      const { bytesWritten } = await this.handle.write(buffer, offset, buffer.length - offset);
      offset += bytesWritten;
    }
  }
}
