import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const BLOCK = 512;
const MAX_BYTES = 67_108_864;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 32;
const MAX_PATH_BYTES = 255;
const MAX_STORED_BYTES = 256;
const ZERO = 0;

const USTAR_MAGIC = Buffer.from("ustar\0", "ascii");
const USTAR_VERSION = Buffer.from("00", "ascii");

const fail = (reason = ""): never => { throw new Error(`Evidence-volume export failed${reason ? ` (${reason})` : ""}`); };
const isZero = (value: Uint8Array): boolean => value.every((byte) => byte === 0);
const utf8 = (value: Uint8Array): string => {
  const parsed = Buffer.from(value).toString("utf8");
  if (!Buffer.from(parsed, "utf8").equals(Buffer.from(value))) return fail();
  return parsed;
};
const isEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
};
const pad = (value: number): number => Math.ceil(value / BLOCK) * BLOCK;
const text = (value: Uint8Array, start: number, length: number): string => {
  const field = value.subarray(start, start + length);
  const nul = field.indexOf(0);
  if (nul < 0) return utf8(field);
  for (let index = nul + 1; index < field.length; index += 1) {
    if (field[index] !== 0) return fail();
  }
  return utf8(field.subarray(0, nul));
};
const parseOctal = (value: Uint8Array, start: number, length: number): number => {
  const field = value.subarray(start, start + length);
  if (field[length - 1] !== ZERO) return fail();
  for (let index = 0; index < length - 1; index += 1) {
    const byte = field[index]!;
    if (byte < 48 || byte > 55) return fail();
  }
  const parsed = Number.parseInt(utf8(field.subarray(0, length - 1)), 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fail();
  return parsed;
};
const parseChecksum = (value: Uint8Array): number => {
  const field = value.subarray(148, 156);
  if (field[6] !== ZERO || field[7] !== 0x20) return fail();
  for (let index = 0; index < 6; index += 1) {
    const byte = field[index]!;
    if (byte < 48 || byte > 55) return fail();
  }
  const parsed = Number.parseInt(utf8(field.subarray(0, 6)), 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0o777777) return fail();
  return parsed;
};
const writeOctal = (value: number, width: number): Buffer => {
  const raw = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || raw.length > width - 1) return fail();
  return Buffer.from(`${raw.padStart(width - 1, "0")}\0`, "ascii");
};
const writeChecksum = (header: Buffer): void => {
  let checksum = 0;
  header.fill(0x20, 148, 156);
  for (let index = 0; index < BLOCK; index += 1) checksum += header[index]!;
  if (checksum > 0o777777) return fail();
  const field = `${checksum.toString(8).padStart(6, "0")}\0 `;
  header.set(Buffer.from(field, "ascii"), 148);
};
const hasFileAncestorOrDescendantConflict = (files: ReadonlySet<string>, key: string, directoryMode: boolean): boolean => {
  for (const file of files) {
    if (file === key) return true;
    if (key.startsWith(`${file}/`)) return true;
    if (!directoryMode && file.startsWith(`${key}/`)) return true;
  }
  return false;
};
const hasDirectoryConflict = (directories: ReadonlySet<string>, key: string): boolean => {
  for (const directory of directories) if (directory === key) return true;
  return false;
};

type ArchiveEntryType = "directory" | "file";
interface ParsedEntry {
  readonly bytes: Uint8Array;
  readonly path: string;
  readonly size: number;
  readonly type: ArchiveEntryType;
  readonly stored: string;
}

const splitStored = (stored: string): { readonly name: string; readonly prefix: string } => {
  const storedBytes = Buffer.from(stored, "utf8");
  if (storedBytes.byteLength <= 100) return Object.freeze({ prefix: "", name: stored });
  if (storedBytes.byteLength > MAX_STORED_BYTES) return fail();

  let split = -1;
  for (let index = storedBytes.lastIndexOf(0x2f); index > 0; index = storedBytes.lastIndexOf(0x2f, index - 1)) {
    const prefixLength = index;
    const nameLength = storedBytes.byteLength - index - 1;
    if (prefixLength <= 155 && nameLength <= 100 && nameLength > 0) {
      split = index;
      break;
    }
  }
  if (split < 0) return fail();

  return Object.freeze({
    name: storedBytes.subarray(split + 1).toString("utf8"),
    prefix: storedBytes.subarray(0, split).toString("utf8")
  });
};

const entryPath = (header: Uint8Array): { readonly type: ArchiveEntryType; readonly path: string; readonly stored: string } => {
  const name = text(header, 0, 100);
  const prefix = text(header, 345, 155);
  const stored = prefix ? `${prefix}/${name}` : name;
  const canonical = splitStored(stored);
  if (canonical.name !== name || canonical.prefix !== prefix) return fail();

  if (!name) return fail();
  if (prefix === "" && Buffer.byteLength(stored, "utf8") > 100) return fail();
  if (prefix !== "" && (Buffer.byteLength(stored, "utf8") <= 100 || Buffer.byteLength(prefix, "utf8") > 155 || Buffer.byteLength(name, "utf8") > 100)) return fail();
  if (stored.startsWith("/") || stored.includes("\\") || stored.includes("\0")) return fail();
  if (stored.includes("//")) return fail();

  const typeByte = header[156]!;
  const type = typeByte === 48 ? "file" : typeByte === 53 ? "directory" : null;
  if (!type) return fail();

  let path: string;
  if (type === "directory") {
    if (!stored.endsWith("/")) return fail();
    path = stored.slice(0, -1);
    if (path === "" || path.endsWith("/")) return fail();
  } else {
    if (stored.endsWith("/")) return fail();
    path = stored;
  }

  if (path === "" || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return fail();
  const parts = path.split("/");
  if (parts.length > MAX_DEPTH || parts.some((part) => part === "" || part === "." || part === "..")) return fail();
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      if (code < 0x20 || code === 0x7f) return fail();
    }
    if (part.includes("\\") || part.includes("\0")) return fail();
  }

  return Object.freeze({ path, stored, type });
};

const rebuildHeader = (entry: ParsedEntry): Buffer => {
  const out = Buffer.alloc(BLOCK);
  const split = splitStored(entry.stored);
  out.set(Buffer.from(split.name, "utf8"), 0);
  out.set(writeOctal(entry.type === "directory" ? 0o755 : 0o644, 8), 100);
  out.set(writeOctal(0, 8), 108);
  out.set(writeOctal(0, 8), 116);
  out.set(writeOctal(entry.size, 12), 124);
  out.set(writeOctal(0, 12), 136);
  out[156] = entry.type === "directory" ? 53 : 48;
  out.set(USTAR_MAGIC, 257);
  out.set(USTAR_VERSION, 263);
  if (split.prefix) out.set(Buffer.from(split.prefix, "utf8"), 345);
  out.set(writeOctal(0, 8), 329);
  out.set(writeOctal(0, 8), 337);
  writeChecksum(out);
  return out;
};

const rebuildArchive = (entries: readonly ParsedEntry[]): Uint8Array => {
  const output: Buffer[] = [];
  const sorted = [...entries].sort((left, right): number => {
    const pathOrder = Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
    return pathOrder !== 0 ? pathOrder : 0;
  });

  for (const entry of sorted) {
    output.push(rebuildHeader(entry));
    if (entry.size > 0) {
      const data = Buffer.alloc(pad(entry.size));
      data.set(Buffer.from(entry.bytes));
      output.push(data);
    }
  }

  output.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return Buffer.concat(output);
};

/** Parses evidence archives as strict canonical USTAR. */
export const canonicalEvidenceArchive = (raw: unknown): {
  readonly bytes: Uint8Array;
  readonly files: readonly Readonly<{ bytes: number; path: string; sha256: `sha256:${string}` }>[];
  readonly itemCount: number;
} => {
  if (!(raw instanceof Uint8Array) || raw.byteLength < BLOCK * 2 || raw.byteLength > MAX_BYTES || raw.byteLength % BLOCK !== 0) return fail();

  const files = new Set<string>();
  const directories = new Set<string>();
  const entries: ParsedEntry[] = [];
  let offset = 0;
  let itemCount = 0;

  while (offset < raw.byteLength) {
    const header = raw.subarray(offset, offset + BLOCK);
    if (header.byteLength !== BLOCK) return fail();
    offset += BLOCK;

    if (isZero(header)) {
      if (itemCount === 0 || offset + BLOCK > raw.byteLength) return fail();
      if (!isZero(raw.subarray(offset, offset + BLOCK))) return fail();
      offset += BLOCK;
      if (offset !== raw.byteLength) return fail();
      const inventory = entries.filter((entry) => entry.type === "file")
        .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
        .map((entry) => Object.freeze({
          bytes: entry.size,
          path: entry.path,
          sha256: `sha256:${createHash("sha256").update(entry.bytes).digest("hex")}` as const
        }));
      return Object.freeze({ bytes: rebuildArchive(entries), files: Object.freeze(inventory), itemCount });
    }

    if (!isEqual(header.subarray(257, 263), USTAR_MAGIC)) return fail();
    if (header[263] !== 48 || header[264] !== 48) return fail();
    if (!isZero(header.subarray(157, 257))) return fail();

    const claimedChecksum = parseChecksum(header);
    let actualChecksum = 0;
    for (let index = 0; index < BLOCK; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    }
    if (actualChecksum !== claimedChecksum) return fail();

    const mode = parseOctal(header, 100, 8);
    const uid = parseOctal(header, 108, 8);
    const gid = parseOctal(header, 116, 8);
    const size = parseOctal(header, 124, 12);
    const mtime = parseOctal(header, 136, 12);
    if (uid !== 0 || gid !== 0 || mtime !== 0) return fail();

    const metadata = entryPath(header);
    if (metadata.type === "directory") {
      if (hasDirectoryConflict(directories, metadata.path)) return fail();
      if (hasFileAncestorOrDescendantConflict(files, metadata.path, true)) return fail();
      if (mode !== 0o755 || size !== 0) return fail();
    } else {
      if (hasFileAncestorOrDescendantConflict(files, metadata.path, false)) return fail();
      if (hasDirectoryConflict(directories, metadata.path)) return fail();
      if (mode !== 0o644 || size > MAX_BYTES) return fail();
    }

    if (text(header, 265, 32) !== "" || text(header, 297, 32) !== "") return fail();
    if (parseOctal(header, 329, 8) !== 0 || parseOctal(header, 337, 8) !== 0) return fail();
    if (!isZero(header.subarray(500, 512))) return fail();
    if (metadata.type === "file") files.add(metadata.path);
    else directories.add(metadata.path);
    if (itemCount >= MAX_ENTRIES) return fail();
    itemCount += 1;

    const dataEnd = offset + size;
    if (dataEnd > raw.byteLength) return fail();
    const paddedEnd = offset + pad(size);
    if (paddedEnd > raw.byteLength) return fail();
    if (!isZero(raw.subarray(dataEnd, paddedEnd))) return fail();
    entries.push(Object.freeze({ bytes: raw.subarray(offset, dataEnd), path: metadata.path, size, stored: metadata.stored, type: metadata.type }));
    offset = paddedEnd;
  }

  return fail();
};
