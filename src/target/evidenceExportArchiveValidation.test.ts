import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { canonicalEvidenceArchive } from "./evidenceExportArchive.js";

type Entry = readonly [path: string, bytes: Buffer, type: "0" | "5"];

const BLOCK = 512;
const pad = (value: number): number => Math.ceil(value / BLOCK) * BLOCK;
const octal = (value: number, width: number): Buffer => Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
const checksum = (header: Buffer): void => {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += header[index]!;
  header.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
};
const split = (stored: string): { readonly name: string; readonly prefix: string } => {
  const bytes = Buffer.from(stored, "utf8");
  if (bytes.byteLength <= 100) return { name: stored, prefix: "" };
  for (let index = bytes.lastIndexOf(0x2f); index > 0; index = bytes.lastIndexOf(0x2f, index - 1)) {
    if (index <= 155 && bytes.byteLength - index - 1 <= 100) {
      return {
        name: bytes.subarray(index + 1).toString("utf8"),
        prefix: bytes.subarray(0, index).toString("utf8"),
      };
    }
  }
  throw new Error("test path cannot be stored");
};
const header = (stored: string, bytes: Buffer, type: "0" | "5"): Buffer => {
  const result = Buffer.alloc(BLOCK);
  const fields = split(stored);
  result.set(Buffer.from(fields.name, "utf8"), 0);
  result.set(octal(type === "5" ? 0o755 : 0o644, 8), 100);
  result.set(octal(0, 8), 108);
  result.set(octal(0, 8), 116);
  result.set(octal(bytes.byteLength, 12), 124);
  result.set(octal(0, 12), 136);
  result[156] = type.charCodeAt(0);
  result.set(Buffer.from("ustar\0", "ascii"), 257);
  result.set(Buffer.from("00", "ascii"), 263);
  result.set(octal(0, 8), 329);
  result.set(octal(0, 8), 337);
  result.set(Buffer.from(fields.prefix, "utf8"), 345);
  checksum(result);
  return result;
};
const archive = (entries: readonly Entry[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const [stored, bytes, type] of entries) {
    blocks.push(header(stored, bytes, type));
    const body = Buffer.alloc(pad(bytes.byteLength));
    body.set(bytes);
    blocks.push(body);
  }
  return Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]);
};
const mutateFirstHeader = (raw: Buffer, mutate: (value: Buffer) => void, repairChecksum = true): Buffer => {
  const result = Buffer.from(raw);
  const first = result.subarray(0, BLOCK) as Buffer;
  mutate(first);
  if (repairChecksum) checksum(first);
  return result;
};

describe("evidence export archive hostile-boundary validation", () => {
  it("rejects non-archives, undersized, oversized, and unaligned byte sequences", () => {
    expect(() => canonicalEvidenceArchive(null)).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(Buffer.alloc(BLOCK))).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(Buffer.alloc(67_108_864 + BLOCK))).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(Buffer.alloc(BLOCK * 2 + 1))).toThrow("Evidence-volume export failed");
  });

  it("rejects invalid UTF-8 and nonzero bytes after text terminators", () => {
    const valid = archive([["safe", Buffer.from("x"), "0"]]);
    const invalidUtf8 = mutateFirstHeader(valid, (value) => {
      value.fill(0, 0, 100);
      value[0] = 0xc3;
      value[1] = 0x28;
    });
    expect(() => canonicalEvidenceArchive(invalidUtf8)).toThrow("Evidence-volume export failed");

    const nameTail = mutateFirstHeader(valid, (value) => { value[5] = 0x78; });
    expect(() => canonicalEvidenceArchive(nameTail)).toThrow("Evidence-volume export failed");

    const ownerTail = mutateFirstHeader(valid, (value) => {
      value[265] = 0x61;
      value[267] = 0x62;
    });
    expect(() => canonicalEvidenceArchive(ownerTail)).toThrow("Evidence-volume export failed");
  });

  it("rejects empty names, missing octal terminators, and checksum mismatches", () => {
    const valid = archive([["safe", Buffer.from("x"), "0"]]);
    const emptyName = mutateFirstHeader(valid, (value) => { value.fill(0, 0, 100); });
    expect(() => canonicalEvidenceArchive(emptyName)).toThrow("Evidence-volume export failed");

    const missingOctalTerminator = mutateFirstHeader(valid, (value) => { value[107] = 0x20; });
    expect(() => canonicalEvidenceArchive(missingOctalTerminator)).toThrow("Evidence-volume export failed");

    const mismatchedChecksum = mutateFirstHeader(valid, (value) => { value[0] = 0x74; }, false);
    expect(() => canonicalEvidenceArchive(mismatchedChecksum)).toThrow("Evidence-volume export failed");
  });

  it("rejects exact duplicate files and directories", () => {
    expect(() => canonicalEvidenceArchive(archive([
      ["same", Buffer.from("first"), "0"],
      ["same", Buffer.from("second"), "0"],
    ]))).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(archive([
      ["same/", Buffer.alloc(0), "5"],
      ["same/", Buffer.alloc(0), "5"],
    ]))).toThrow("Evidence-volume export failed");
  });

  it("rejects file-directory identity conflicts in either entry order", () => {
    expect(() => canonicalEvidenceArchive(archive([
      ["same", Buffer.from("file"), "0"],
      ["same/", Buffer.alloc(0), "5"],
    ]))).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(archive([
      ["same/", Buffer.alloc(0), "5"],
      ["same", Buffer.from("file"), "0"],
    ]))).toThrow("Evidence-volume export failed");
  });

  it("rejects invalid directory modes and file sizes beyond either archive boundary", () => {
    const directory = archive([["dir/", Buffer.alloc(0), "5"]]);
    const badDirectoryMode = mutateFirstHeader(directory, (value) => { value.set(octal(0o700, 8), 100); });
    expect(() => canonicalEvidenceArchive(badDirectoryMode)).toThrow("Evidence-volume export failed");

    const file = archive([["safe", Buffer.from("x"), "0"]]);
    const beyondPolicy = mutateFirstHeader(file, (value) => { value.set(octal(67_108_865, 12), 124); });
    expect(() => canonicalEvidenceArchive(beyondPolicy)).toThrow("Evidence-volume export failed");
    const beyondArchive = mutateFirstHeader(file, (value) => { value.set(octal(4_096, 12), 124); });
    expect(() => canonicalEvidenceArchive(beyondArchive)).toThrow("Evidence-volume export failed");
  });

  it("rejects a damaged second terminator and remaining path bounds", () => {
    const valid = archive([["safe", Buffer.from("x"), "0"]]);
    const damagedTerminator = Buffer.from(valid);
    damagedTerminator[valid.byteLength - BLOCK] = 1;
    expect(() => canonicalEvidenceArchive(damagedTerminator)).toThrow("Evidence-volume export failed");

    expect(() => canonicalEvidenceArchive(archive([["a\\b", Buffer.from("x"), "0"]])))
      .toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(archive([[
      Array.from({ length: 33 }, () => "a").join("/"),
      Buffer.from("x"),
      "0",
    ]]))).toThrow("Evidence-volume export failed");
    expect(() => canonicalEvidenceArchive(archive([[
      `${"a".repeat(155)}/${"b".repeat(100)}`,
      Buffer.from("x"),
      "0",
    ]]))).toThrow("Evidence-volume export failed");
  });
});
