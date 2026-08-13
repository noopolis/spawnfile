import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalEvidenceArchive } from "./evidenceExportArchive.js";

type ArchiveEntry = readonly [string, Buffer, "0" | "5"];

const BLOCK = 512;
const ZERO = Buffer.alloc(1);
const pad = (value: number): number => Math.ceil(value / BLOCK) * BLOCK;
const writeChecksum = (header: Buffer): void => {
  header.fill(32, 148, 156);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += header[index]!;
  if (sum > 0o777777) throw new Error("checksum overflow");
  const field = `${sum.toString(8).padStart(6, "0")}\0 `;
  header.set(Buffer.from(field, "ascii"), 148);
};
const writeOctal = (value: number, width: number): Buffer => {
  const raw = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || raw.length > width - 1) throw new Error("field overflow");
  return Buffer.from(`${raw.padStart(width - 1, "0")}\0`, "ascii");
};
const splitStored = (storedPath: string): { readonly name: string; readonly prefix: string } => {
  const storedBytes = Buffer.from(storedPath, "utf8");
  if (storedBytes.byteLength > 256) throw new Error("path too long");
  if (storedBytes.byteLength === 0) throw new Error("empty path");

  if (storedBytes.byteLength <= 100) return Object.freeze({ prefix: "", name: storedPath });

  let split = -1;
  for (let index = storedBytes.lastIndexOf(47); index > 0; index = storedBytes.lastIndexOf(47, index - 1)) {
    const prefixLength = index;
    const nameLength = storedBytes.byteLength - index - 1;
    if (prefixLength <= 155 && nameLength <= 100 && nameLength > 0) {
      split = index;
      break;
    }
  }
  if (split < 0) throw new Error("non-canonical path split");

  const prefix = storedBytes.subarray(0, split).toString("utf8");
  const base = storedBytes.subarray(split + 1).toString("utf8");
  if (!base || Buffer.byteLength(base, "utf8") > 100) throw new Error("invalid base");
  return Object.freeze({ name: base, prefix });
};
const entry = (path: string, bytes: Uint8Array, type: "0" | "5"): { readonly header: Buffer; readonly body: Buffer } => {
  const out = Buffer.alloc(BLOCK);
  const split = splitStored(path);
  out.set(Buffer.from(split.name, "utf8"), 0);
  out.set(writeOctal(type === "5" ? 0o755 : 0o644, 8), 100);
  out.set(writeOctal(0, 8), 108);
  out.set(writeOctal(0, 8), 116);
  out.set(writeOctal(bytes.byteLength, 12), 124);
  out.set(writeOctal(0, 12), 136);
  out.fill(32, 148, 156);
  out[156] = type === "5" ? 53 : 48;
  out.set(Buffer.from("ustar\0", "ascii"), 257);
  out.set(Buffer.from("00", "ascii"), 263);
  out.set(writeOctal(0, 8), 329);
  out.set(writeOctal(0, 8), 337);
  if (split.prefix) out.set(Buffer.from(split.prefix, "utf8"), 345);
  writeChecksum(out);
  const body = Buffer.alloc(pad(bytes.byteLength));
  body.set(Buffer.from(bytes));
  return Object.freeze({ header: out, body });
};
const archive = (entries: readonly ArchiveEntry[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const [name, bytes, type] of entries) {
    const { header, body } = entry(name, bytes, type);
    blocks.push(header, body);
  }
  return Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]);
};
const archiveWithOffsets = (entries: readonly ArchiveEntry[]): { readonly bytes: Buffer; readonly headerOffsets: number[] } => {
  let offset = 0;
  const blocks = [];
  const headerOffsets: number[] = [];
  for (const [name, bytes, type] of entries) {
    const { header, body } = entry(name, bytes, type);
    blocks.push(header, body);
    headerOffsets.push(offset);
    offset += BLOCK + body.byteLength;
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Object.freeze({ bytes: Buffer.concat(blocks), headerOffsets });
};
const mutateHeader = (raw: Buffer, headerOffset: number, mutate: (header: Buffer) => void, keepChecksum = true): Buffer => {
  const copy = Buffer.from(raw);
  const header = copy.subarray(headerOffset, headerOffset + 512) as Buffer;
  mutate(header);
  if (keepChecksum) writeChecksum(header);
  return copy;
};
const readText = (header: Buffer, start: number, length: number): string => {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  return Buffer.from(field.subarray(0, nul < 0 ? length : nul)).toString("utf8");
};
const readStored = (header: Buffer): string => {
  const name = readText(header, 0, 100);
  const prefix = readText(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
};
const textDigest = (bytes: Uint8Array): string => createHash("sha256").update(Buffer.from(bytes)).digest("hex");
const archiveEntryPaths = (archiveBytes: Uint8Array): string[] => {
  const value = Buffer.from(archiveBytes);
  const paths: string[] = [];
  let offset = 0;
  while (offset + BLOCK <= value.byteLength) {
    const header = value.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(readText(header, 124, 12), 8);
    paths.push(readStored(Buffer.from(header)));
    offset += BLOCK + pad(size);
  }
  return paths;
};

describe("evidence export archive parser", () => {
  it("accepts canonical multi-entry USTAR archives", () => {
    const raw = archive([
      ["dir/", Buffer.alloc(0), "5"],
      ["dir/data.txt", Buffer.from("x"), "0"],
      ["dir/nested/", Buffer.alloc(0), "5"],
      ["dir/nested/leaf", Buffer.from("yes"), "0"],
      [`${"p".repeat(95)}/leaf_${"l".repeat(10)}`, Buffer.from("ok"), "0"],
      ["safe", Buffer.from("done"), "0"]
    ]);
    const parsed = canonicalEvidenceArchive(raw);
    expect(canonicalEvidenceArchive(parsed.bytes).bytes).toEqual(parsed.bytes);
    expect(parsed.itemCount).toBe(6);
    expect(parsed.files.map(({ bytes, path }) => ({ bytes, path }))).toEqual([
      { bytes: 1, path: "dir/data.txt" },
      { bytes: 3, path: "dir/nested/leaf" },
      { bytes: 2, path: `${"p".repeat(95)}/leaf_${"l".repeat(10)}` },
      { bytes: 4, path: "safe" }
    ]);
  });

  it("rejects a later-entry header defect even when the first entry is valid", () => {
    const valid = archiveWithOffsets([["safe", Buffer.from("a"), "0"], ["safe2", Buffer.from("b"), "0"]]);
    const secondHeaderOffset = valid.headerOffsets[1]!;

    const badMagic = mutateHeader(valid.bytes, secondHeaderOffset, (header) => { header[257] = 0; });
    expect(() => canonicalEvidenceArchive(badMagic)).toThrow("Evidence-volume export failed");

    const badVersion = mutateHeader(valid.bytes, secondHeaderOffset, (header) => { header[263] = 49; });
    expect(() => canonicalEvidenceArchive(badVersion)).toThrow("Evidence-volume export failed");

    const badChecksumForm = mutateHeader(valid.bytes, secondHeaderOffset, (header) => {
      header.set(Buffer.from("7777777\0 ", "ascii"), 148);
    }, false);
    expect(() => canonicalEvidenceArchive(badChecksumForm)).toThrow("Evidence-volume export failed");

    const badMetadata = mutateHeader(valid.bytes, secondHeaderOffset, (header) => {
      header[108] = 49;
      header[109] = 48;
      header[110] = 48;
      header[111] = 48;
      header[112] = 48;
      header[113] = 48;
      header[114] = 48;
      header[115] = 0;
    });
    expect(() => canonicalEvidenceArchive(badMetadata)).toThrow("Evidence-volume export failed");
  });

  it("accepts and rejects canonical directory semantics", () => {
    const good = archive([["root/", Buffer.alloc(0), "5"], ["root/file", Buffer.from("ok"), "0"]]);
    expect(canonicalEvidenceArchive(good).itemCount).toBe(2);

    const missingSlash = archive([["dir", Buffer.alloc(0), "5"]]);
    expect(() => canonicalEvidenceArchive(missingSlash)).toThrow("Evidence-volume export failed");
    const fileSlash = archive([["file/", Buffer.from("x"), "0"]]);
    expect(() => canonicalEvidenceArchive(fileSlash)).toThrow("Evidence-volume export failed");
    const doubleSlash = archive([["dir//", Buffer.alloc(0), "5"]]);
    expect(() => canonicalEvidenceArchive(doubleSlash)).toThrow("Evidence-volume export failed");
  });

  it("rejects non-canonical checksum encodings", () => {
    const base = archiveWithOffsets([["safe", Buffer.from("x"), "0"]]).bytes;

    const nonCanonicalFields: Array<[string, (header: Buffer) => void]> = [
      ["seven digits", (header) => header.set(Buffer.from("7777777\0 ", "ascii"), 148)],
      ["nul nul", (header) => { header[154] = ZERO[0]; header[155] = ZERO[0]; }],
      ["space nul", (header) => { header[154] = 0x20; header[155] = ZERO[0]; }],
      ["non-octal", (header) => { header[148] = 56; }],
      ["mismatch overflow", (header) => { header.set(Buffer.from("999999\0 ", "ascii"), 148); }]
    ];
    for (const [name, mutate] of nonCanonicalFields) {
      const malformed = mutateHeader(base, 0, mutate, false);
      expect(() => canonicalEvidenceArchive(malformed), name).toThrow("Evidence-volume export failed");
    }
  });

  it("rejects non-canonical metadata fields", () => {
    const base = archiveWithOffsets([["safe", Buffer.from("x"), "0"]]).bytes;
    const baseHeader = 0;
    const mutators: Array<[string, (header: Buffer) => void]> = [
      ["non-octal uid encoding with NUL inside", (header) => { header[108] = 48; header.fill(0, 109, 116); }],
      ["non-zero uid", (header) => { header.set(writeOctal(1, 8), 108); }],
      ["non-octal gid encoding with NUL inside", (header) => { header[116] = 49; header.fill(0, 117, 124); }],
      ["non-zero gid", (header) => { header.set(writeOctal(1, 8), 116); }],
      ["non-octal mtime encoding with NUL inside", (header) => { header[136] = 49; header.fill(0, 137, 148); }],
      ["non-zero mtime", (header) => { header.set(writeOctal(1, 12), 136); }],
      ["non-octal file mode with abbreviated digits", (header) => { header[100] = 48; header.fill(0, 101, 108); }],
      ["bad file mode", (header) => { header.set(writeOctal(0o600, 8), 100); }],
      ["non-octal file size with abbreviated digits", (header) => { header[124] = 49; header.fill(0, 125, 136); }],
      ["base-256 size", (header) => { header[124] = 0x80; }],
      ["directory-size", (header) => {
        header[156] = 53;
        header.set(writeOctal(0o755, 8), 100);
        header.set(writeOctal(1, 12), 124);
      }],
      ["non-empty uname", (header) => { header.set(Buffer.from("root\0", "ascii"), 265); }],
      ["non-empty gname", (header) => { header.set(Buffer.from("root\0", "ascii"), 297); }],
      ["non-zero devmajor", (header) => { header.set(writeOctal(1, 8), 329); }],
      ["non-zero devminor", (header) => { header.set(writeOctal(1, 8), 337); }],
      ["non-zero reserved tail", (header) => { header[500] = 1; }],
      ["hostile linkname", (header) => { header[157] = 102; }],
      ["NUL regular typeflag", (header) => { header[156] = 0; }]
    ];
    for (const [name, mutate] of mutators) {
      const malformed = mutateHeader(base, baseHeader, mutate);
      expect(() => canonicalEvidenceArchive(malformed), name).toThrow("Evidence-volume export failed");
    }
  });

  it("rejects path canonicality and ancestor/file confusion", () => {
    const baseHeader = archiveWithOffsets([["prefix-test/leaf", Buffer.from("x"), "0"]]).bytes;
    const badPrefix = mutateHeader(baseHeader, 0, (header) => {
      header.fill(0, 345, 500);
      header.set(Buffer.from("bad/prefix/\0", "ascii"), 345);
    });
    expect(() => canonicalEvidenceArchive(badPrefix)).toThrow("Evidence-volume export failed");
    const nonCanonicalSplit = mutateHeader(baseHeader, 0, (header) => {
      header.fill(0, 0, 100);
      header.fill(0, 345, 500);
      header.set(Buffer.from("leaf\0", "ascii"), 0);
      header.set(Buffer.from("prefix-test\0", "ascii"), 345);
    });
    expect(() => canonicalEvidenceArchive(nonCanonicalSplit)).toThrow("Evidence-volume export failed");
    const c0PathComponent = archive([
      [`safe${String.fromCharCode(0x1f)}name`, Buffer.from("x"), "0"]
    ]);
    expect(() => canonicalEvidenceArchive(c0PathComponent)).toThrow("Evidence-volume export failed");
    const delPathComponent = archive([
      [`safe${String.fromCharCode(0x7f)}name`, Buffer.from("x"), "0"]
    ]);
    expect(() => canonicalEvidenceArchive(delPathComponent)).toThrow("Evidence-volume export failed");

    const invalidPaths: Array<ArchiveEntry[]> = [
      [["/abs", Buffer.from("x"), "0"]],
      [["./safe", Buffer.from("x"), "0"]],
      [["a/../x", Buffer.from("x"), "0"]],
      [["a", Buffer.from("x"), "0"], ["a/b", Buffer.from("y"), "0"]],
      [["a/b", Buffer.from("y"), "0"], ["a", Buffer.from("x"), "0"]]
    ];
    for (const [index, entries] of invalidPaths.entries()) {
      const raw = archive(entries);
      expect(() => canonicalEvidenceArchive(raw), `invalid path ${index + 1}`).toThrow("Evidence-volume export failed");
    }
  });

  it("rejects regular-file ancestor/descendant conflicts in both orderings", () => {
    const childAfter = archive([
      ["a", Buffer.from("x"), "0"],
      ["a/b", Buffer.from("y"), "0"]
    ]);
    expect(() => canonicalEvidenceArchive(childAfter)).toThrow("Evidence-volume export failed");

    const childBefore = archive([
      ["a/b", Buffer.from("y"), "0"],
      ["a", Buffer.from("x"), "0"]
    ]);
    expect(() => canonicalEvidenceArchive(childBefore)).toThrow("Evidence-volume export failed");
  });

  it("accepts explicit directory ancestry with children in both orderings", () => {
    const directoryBefore = archive([
      ["a/", Buffer.alloc(0), "5"],
      ["a/file", Buffer.from("x"), "0"]
    ]);
    expect(canonicalEvidenceArchive(directoryBefore).itemCount).toBe(2);

    const directoryAfter = archive([
      ["a/file", Buffer.from("x"), "0"],
      ["a/", Buffer.alloc(0), "5"]
    ]);
    expect(canonicalEvidenceArchive(directoryAfter).itemCount).toBe(2);
  });

  it("converges equivalent archive entry orders into identical canonical bytes and digest", () => {
    const rawBefore = archive([["a.", Buffer.from("left"), "0"], ["a/", Buffer.alloc(0), "5"], ["safe", Buffer.from("ok"), "0"]]);
    const rawAfter = archive([["safe", Buffer.from("ok"), "0"], ["a.", Buffer.from("left"), "0"], ["a/", Buffer.alloc(0), "5"]]);
    const parsedBefore = canonicalEvidenceArchive(rawBefore);
    const parsedAfter = canonicalEvidenceArchive(rawAfter);

    expect(parsedBefore.itemCount).toBe(3);
    expect(parsedAfter.itemCount).toBe(3);
    expect(Buffer.from(parsedBefore.bytes)).toEqual(Buffer.from(parsedAfter.bytes));
    expect(textDigest(parsedBefore.bytes)).toBe(textDigest(parsedAfter.bytes));
  });

  it("is idempotent for its own canonical output", () => {
    const raw = archive([
      ["dir/", Buffer.alloc(0), "5"],
      ["dir/file", Buffer.from("hello"), "0"],
      ["safe", Buffer.from("done"), "0"]
    ]);
    const first = canonicalEvidenceArchive(raw);
    const second = canonicalEvidenceArchive(first.bytes);
    expect(Buffer.from(first.bytes)).toEqual(Buffer.from(second.bytes));
    expect(second.itemCount).toBe(first.itemCount);
  });

  it("accepts single-component 99-byte directory names and rejects 100-byte directory names", () => {
    const shortDirectory = `${"x".repeat(99)}/`;
    const longDirectory = `${"x".repeat(100)}/`;
    expect(canonicalEvidenceArchive(archive([[shortDirectory, Buffer.alloc(0), "5"]])).itemCount).toBe(1);
    expect(() => canonicalEvidenceArchive(archive([[longDirectory, Buffer.alloc(0), "5"]]))).toThrow();
  });

  it("sorts entries by normalized path bytes so `a/` precedes sibling `a.`", () => {
    const rawBefore = archive([["a.", Buffer.from("left"), "0"], ["a/", Buffer.alloc(0), "5"]]);
    const rawAfter = archive([["a/", Buffer.alloc(0), "5"], ["a.", Buffer.from("left"), "0"]]);
    const parsedBefore = canonicalEvidenceArchive(rawBefore);
    const parsedAfter = canonicalEvidenceArchive(rawAfter);
    expect(archiveEntryPaths(parsedBefore.bytes)).toEqual(["a/", "a."]);
    expect(textDigest(parsedBefore.bytes)).toBe(textDigest(parsedAfter.bytes));
  });

  it("accepts nested normalized path length max and re-emits canonical bytes", () => {
    const prefix = "a".repeat(155);
    const base = "b".repeat(99);
    const normalized = `${prefix}/${base}/`;
    expect(Buffer.byteLength(normalized.slice(0, -1), "utf8")).toBe(255);
    const parsed = canonicalEvidenceArchive(archive([[normalized, Buffer.alloc(0), "5"]]));
    expect(parsed.itemCount).toBe(1);
    expect(archiveEntryPaths(parsed.bytes)).toEqual([normalized]);
    expect(canonicalEvidenceArchive(parsed.bytes)).toEqual(parsed);
  });

  it("supports UTF-8 multibyte boundary splitting for file and directory entries", () => {
    const prefixComponent = "界".repeat(33);
    const dirComponent = "界".repeat(32);
    const dirPath = `root/${prefixComponent}/${dirComponent}/`;
    const filePath = `root/${prefixComponent}/leaf`;
    const raw = archive([[filePath, Buffer.from("data"), "0"], [dirPath, Buffer.alloc(0), "5"]]);
    const parsed = canonicalEvidenceArchive(raw);
    const paths = archiveEntryPaths(parsed.bytes);

    expect(paths).toContain(dirPath);
    expect(paths).toContain(filePath);

    const value = Buffer.from(parsed.bytes);
    let offset = 0;
    while (offset + BLOCK <= value.byteLength) {
      const header = Buffer.from(value.subarray(offset, offset + BLOCK));
      if (header.every((byte) => byte === 0)) break;
      const stored = readStored(header);
      const size = Number.parseInt(readText(header, 124, 12), 8);
      if (stored === dirPath || stored === filePath) {
        const name = readText(header, 0, 100);
        const prefix = readText(header, 345, 155);
        expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(100);
        expect(Buffer.byteLength(prefix, "utf8")).toBeLessThanOrEqual(155);
      }
      offset += BLOCK + pad(size);
    }
  });

  it("allows UTF-8-safe long components beyond legacy per-component JS-length limits", () => {
    const longComponent = "x".repeat(130);
    const raw = archive([[`${longComponent}/leaf`, Buffer.from("ok"), "0"]]);
    const parsed = canonicalEvidenceArchive(raw);

    expect(archiveEntryPaths(parsed.bytes)).toEqual([`${longComponent}/leaf`]);
    expect(parsed.itemCount).toBe(1);
  });

  it("rejects malformed terminators and padding", () => {
    const valid = archive([["dir/", Buffer.alloc(0), "5"], ["dir/file", Buffer.from("x"), "0"]]);
    const withOneTerminator = valid.slice(0, valid.length - 512);
    const withThreeTerminators = Buffer.concat([valid, Buffer.alloc(512)]);
    const noTerminator = Buffer.alloc(0);
    const withBadPadding = Buffer.from(valid);
    withBadPadding[1537] = 1;
    const withTrailing = Buffer.concat([valid, Buffer.alloc(2)]);

    expect(() => canonicalEvidenceArchive(withOneTerminator)).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(withThreeTerminators)).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(noTerminator)).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(Buffer.alloc(1024))).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(withBadPadding)).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(withTrailing)).toThrow("Evidence-volume export failed");
  });

  it("rejects archives exceeding the entry limit", () => {
    const entries = Array.from({ length: 10_001 }, (_, index): ArchiveEntry => [`file-${index}`, Buffer.alloc(0), "0"]);
    const tooMany = archive(entries);
    expect(() => canonicalEvidenceArchive(tooMany)).toThrow("Evidence-volume export failed");
  });
});
