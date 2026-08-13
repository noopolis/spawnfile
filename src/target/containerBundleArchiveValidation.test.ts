import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseContainerBundleArchive, validateContainerBundleEnvelope } from "./containerBundleArchive.js";

const BLOCK = 512;
const octal = (value: number, width: number): Buffer => Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
const checksum = (header: Buffer): void => {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
};
const archive = (entries: readonly { readonly bytes: Buffer; readonly path: string }[]): Buffer => {
  const output: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK);
    const split = Buffer.byteLength(entry.path, "utf8") <= 100 ? -1 : entry.path.lastIndexOf("/");
    header.set(Buffer.from(split < 0 ? entry.path : entry.path.slice(split + 1), "utf8"), 0);
    if (split >= 0) header.set(Buffer.from(entry.path.slice(0, split), "utf8"), 345);
    header.set(octal(0o644, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(entry.bytes.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header[156] = 48;
    header.set(Buffer.from("ustar\0", "ascii"), 257);
    header.set(Buffer.from("00", "ascii"), 263);
    checksum(header);
    output.push(header, entry.bytes, Buffer.alloc((BLOCK - entry.bytes.byteLength % BLOCK) % BLOCK));
  }
  output.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(output);
};
const digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const mutateHeader = (raw: Buffer, change: (header: Buffer) => void, repair = true): Buffer => {
  const copy = Buffer.from(raw);
  const header = copy.subarray(0, BLOCK) as Buffer;
  change(header);
  if (repair) checksum(header);
  return copy;
};
const reject = (bytes: Uint8Array, paths = ["safe"]): void => {
  expect(() => parseContainerBundleArchive(bytes, paths, digest(bytes))).toThrow("Container bundle archive failed");
};

describe("container bundle archive validation boundaries", () => {
  it("bounds raw bytes, digest syntax, and the canonical allowlist", () => {
    const valid = archive([{ path: "safe", bytes: Buffer.from("x") }]);
    expect(() => parseContainerBundleArchive(null, ["safe"], digest(valid))).toThrow("Container bundle archive failed");
    expect(() => parseContainerBundleArchive(Buffer.alloc(BLOCK), ["safe"], digest(Buffer.alloc(BLOCK)))).toThrow("Container bundle archive failed");
    const oversized = Buffer.alloc(4_194_304 + BLOCK);
    expect(() => parseContainerBundleArchive(oversized, ["safe"], digest(oversized))).toThrow("Container bundle archive failed");
    const unaligned = Buffer.concat([valid, Buffer.from([0])]);
    expect(() => parseContainerBundleArchive(unaligned, ["safe"], digest(unaligned))).toThrow("Container bundle archive failed");
    expect(() => parseContainerBundleArchive(valid, ["safe"], "bad")).toThrow("Container bundle archive failed");
    expect(() => parseContainerBundleArchive(valid, ["safe"], `sha256:${"0".repeat(64)}`)).toThrow("Container bundle archive failed");
    expect(() => parseContainerBundleArchive(valid, [], digest(valid))).toThrow("Container bundle archive failed");
    expect(() => parseContainerBundleArchive(valid, Array.from({ length: 33 }, (_, index) => `p${String(index).padStart(2, "0")}`), digest(valid))).toThrow("Container bundle archive failed");
    expect(() => parseContainerBundleArchive(valid, ["z", "a"], digest(valid))).toThrow("Container bundle archive failed");
    expect(() => parseContainerBundleArchive(valid, ["a//b"], digest(valid))).toThrow("Container bundle archive failed");
    expect(() => parseContainerBundleArchive(valid, ["a/../b"], digest(valid))).toThrow("Container bundle archive failed");
  });

  it("accepts a full name field and rejects hostile text encodings", () => {
    const fullName = "a".repeat(100);
    const full = archive([{ path: fullName, bytes: Buffer.from("x") }]);
    expect(parseContainerBundleArchive(full, [fullName], digest(full)).entries[0]?.path).toBe(fullName);

    const valid = archive([{ path: "safe", bytes: Buffer.from("x") }]);
    reject(mutateHeader(valid, (header) => { header[5] = 0x61; }));
    reject(mutateHeader(valid, (header) => {
      header.fill(0, 0, 100);
      header[0] = 0xc3;
      header[1] = 0x28;
    }));
    reject(mutateHeader(valid, (header) => { header.fill(0, 0, 100); }));
    reject(mutateHeader(valid, (header) => {
      header.fill(0, 0, 100);
      header.fill(0, 345, 500);
      header.set(Buffer.from("leaf"), 0);
      header.set(Buffer.from("short"), 345);
    }));
    reject(mutateHeader(valid, (header) => { header.set(Buffer.from("bad/"), 345); }));
  });

  it("rejects malformed octal and checksum representations", () => {
    const valid = archive([{ path: "safe", bytes: Buffer.from("x") }]);
    reject(mutateHeader(valid, (header) => { header[107] = 0x20; }));
    reject(mutateHeader(valid, (header) => { header[100] = 0x38; }));
    reject(mutateHeader(valid, (header) => { header.fill(0x20, 148, 156); }, false));
    reject(mutateHeader(valid, (header) => { header[0] = 0x74; }, false));
  });

  it("rejects every security-relevant header metadata drift", () => {
    const valid = archive([{ path: "safe", bytes: Buffer.from("x") }]);
    const changes: ReadonlyArray<(header: Buffer) => void> = [
      (header) => { header[257] = 0; },
      (header) => { header[263] = 49; },
      (header) => { header[157] = 1; },
      (header) => { header[500] = 1; },
      (header) => { header.set(octal(0o600, 8), 100); },
      (header) => { header.set(octal(1, 8), 108); },
      (header) => { header.set(octal(1, 8), 116); },
      (header) => { header.set(octal(1, 12), 136); },
      (header) => { header[329] = 1; },
      (header) => { header[156] = 53; },
      (header) => { header[265] = 0x61; },
      (header) => { header[297] = 0x61; },
    ];
    for (const change of changes) reject(mutateHeader(valid, change));
  });

  it("rejects malformed terminators, entry cardinality, size, and padding", () => {
    const valid = archive([{ path: "safe", bytes: Buffer.from("x") }]);
    reject(Buffer.alloc(BLOCK * 2));
    reject(valid.subarray(0, valid.byteLength - BLOCK));
    reject(Buffer.concat([valid, Buffer.alloc(BLOCK)]));
    const damagedSecond = Buffer.from(valid);
    damagedSecond[damagedSecond.byteLength - BLOCK] = 1;
    reject(damagedSecond);
    reject(valid, ["safe", "second"]);
    reject(valid, ["other"]);
    reject(mutateHeader(valid, (header) => { header.set(octal(4_096, 12), 124); }));
    const badPadding = Buffer.from(valid);
    badPadding[BLOCK + 1] = 1;
    reject(badPadding);
  });

  it("validates launcher presence, digest, artifact identity, and hostile objects", () => {
    const bytes = archive([{ path: "main.js", bytes: Buffer.from("launcher") }]);
    const parsed = parseContainerBundleArchive(bytes, ["main.js"], digest(bytes));
    const claims = {
      artifact_digest: `sha256:${"a".repeat(64)}`,
      build_policy_digest: `sha256:${"b".repeat(64)}`,
      bundle_digest: `sha256:${"c".repeat(64)}`,
      entrypoint: "main.js",
      launcher_digest: digest(Buffer.from("launcher")),
      network_alias: "world",
      platform: { architecture: "amd64" as const, os: "linux" as const },
      platform_digest: `sha256:${"d".repeat(64)}`,
    };
    expect(() => validateContainerBundleEnvelope(parsed, claims)).not.toThrow();
    expect(() => validateContainerBundleEnvelope(parsed, { ...claims, entrypoint: "missing" })).toThrow("Container bundle archive failed");
    expect(() => validateContainerBundleEnvelope(parsed, { ...claims, launcher_digest: `sha256:${"e".repeat(64)}` })).toThrow("Container bundle archive failed");
    expect(() => validateContainerBundleEnvelope(parsed, { ...claims, artifact_digest: "bad" })).toThrow("Container bundle archive failed");
    expect(() => validateContainerBundleEnvelope(null as never, claims)).toThrow("Container bundle archive failed");
  });
});
