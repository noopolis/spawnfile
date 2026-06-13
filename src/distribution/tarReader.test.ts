import { describe, expect, it } from "vitest";

import { extractSingleFileFromTar } from "./tarReader.js";

const BLOCK = 512;

interface TarEntryOptions {
  name: string;
  content: Buffer;
  typeFlag?: string;
}

const buildTar = (entries: TarEntryOptions[], { trailer = true } = {}): Buffer => {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK);
    header.write(entry.name, 0, "ascii");
    header.write(entry.content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write(entry.typeFlag ?? "0", 156, "ascii");
    // checksum field filled with spaces is acceptable; the reader ignores it.
    header.write("        ", 148, "ascii");
    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(entry.content.length / BLOCK) * BLOCK);
    entry.content.copy(padded);
    blocks.push(padded);
  }
  if (trailer) {
    blocks.push(Buffer.alloc(BLOCK * 2));
  }
  return Buffer.concat(blocks);
};

describe("extractSingleFileFromTar", () => {
  it("extracts a single regular file payload", () => {
    const content = Buffer.from(JSON.stringify({ ok: true }));
    const tar = buildTar([{ content, name: "spawnfile-report.json" }]);
    expect(extractSingleFileFromTar(tar, { maxBytes: 1024 }).toString("utf8")).toBe(
      content.toString("utf8")
    );
  });

  it("rejects symlink entries", () => {
    const tar = buildTar([
      { content: Buffer.from("/etc/passwd"), name: "report.json", typeFlag: "2" }
    ]);
    expect(() => extractSingleFileFromTar(tar, { maxBytes: 1024 })).toThrow(/link entry/);
  });

  it("rejects directory entries", () => {
    const tar = buildTar([{ content: Buffer.alloc(0), name: "dir/", typeFlag: "5" }]);
    expect(() => extractSingleFileFromTar(tar, { maxBytes: 1024 })).toThrow(/directory entry/);
  });

  it("rejects path traversal in entry names", () => {
    const tar = buildTar([{ content: Buffer.from("x"), name: "../escape.json" }]);
    expect(() => extractSingleFileFromTar(tar, { maxBytes: 1024 })).toThrow(/traversal/);
  });

  it("enforces the size cap", () => {
    const tar = buildTar([{ content: Buffer.alloc(2048, 0x61), name: "report.json" }]);
    expect(() => extractSingleFileFromTar(tar, { maxBytes: 1024 })).toThrow(/size cap/);
  });

  it("rejects multiple file entries", () => {
    const tar = buildTar([
      { content: Buffer.from("a"), name: "a.json" },
      { content: Buffer.from("b"), name: "b.json" }
    ]);
    expect(() => extractSingleFileFromTar(tar, { maxBytes: 1024 })).toThrow(/single-file/);
  });

  it("throws when no file entry is present", () => {
    expect(() => extractSingleFileFromTar(Buffer.alloc(BLOCK * 2), { maxBytes: 1024 })).toThrow(
      /No file entry/
    );
  });

  it("rejects a malformed numeric size field", () => {
    const header = Buffer.alloc(BLOCK);
    header.write("report.json", 0, "ascii");
    header.write("99zz9\0", 124, "ascii");
    header.write("0", 156, "ascii");
    const tar = Buffer.concat([header, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK * 2)]);
    expect(() => extractSingleFileFromTar(tar, { maxBytes: 1024 })).toThrow(/invalid numeric field/);
  });

  it("rejects a truncated content payload", () => {
    const header = Buffer.alloc(BLOCK);
    header.write("report.json", 0, "ascii");
    header.write((600).toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write("0", 156, "ascii");
    // Declares 600 bytes but only provides part of one content block.
    const tar = Buffer.concat([header, Buffer.alloc(256)]);
    expect(() => extractSingleFileFromTar(tar, { maxBytes: 1024 })).toThrow(/Truncated/);
  });

  it("skips pax metadata entries before the payload", () => {
    const content = Buffer.from("payload");
    const tar = buildTar([
      { content: Buffer.from("pax data"), name: "pax", typeFlag: "x" },
      { content, name: "report.json" }
    ]);
    expect(extractSingleFileFromTar(tar, { maxBytes: 1024 }).toString("utf8")).toBe("payload");
  });
});
