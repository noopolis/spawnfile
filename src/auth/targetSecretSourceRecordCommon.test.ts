import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  TARGET_SECRET_SOURCE_ERROR,
  assertOrdinaryJsonGraph,
  createCanonicalTargetSecretSourceJson,
  parseCanonicalTargetSecretSourceJson,
  parseTargetSecretSourceOpaqueHandle
} from "./targetSecretSourceRecordCommon.js";

describe("targetSecretSourceRecordCommon", () => {
  it("canonicalizes equal graphs independently of input order", () => {
    const first = createCanonicalTargetSecretSourceJson({ z: 1, A: 2, a: { y: 3, x: [true] } });
    const second = createCanonicalTargetSecretSourceJson({ a: { x: [true], y: 3 }, A: 2, z: 1 });
    expect(first).toEqual(second);
    expect(Buffer.from(first).toString("utf8")).toBe('{"A":2,"a":{"x":[true],"y":3},"z":1}');
    expect(parseCanonicalTargetSecretSourceJson(first)).toEqual({ A: 2, a: { x: [true], y: 3 }, z: 1 });
  });

  it("rejects BOM, malformed UTF-8, noncanonical, trailing, and oversized bytes", () => {
    for (const raw of [
      Buffer.from('\ufeff{"a":1}', "utf8"),
      Buffer.from('{"b":2,"a":1}', "utf8"),
      Buffer.from('{"a":1} ', "utf8"),
      new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
      new Uint8Array(65_537)
    ]) expect(() => parseCanonicalTargetSecretSourceJson(raw)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("normalizes every exported common failure without reflecting a sentinel", () => {
    const sentinel = "TARGET_SECRET_SENTINEL_NEVER_REFLECT";
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const accessor = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => sentinel });
    for (const failure of [
      () => assertOrdinaryJsonGraph(new Proxy({}, {})),
      () => createCanonicalTargetSecretSourceJson(cycle),
      () => createCanonicalTargetSecretSourceJson(accessor),
      () => parseCanonicalTargetSecretSourceJson(sentinel),
      () => parseTargetSecretSourceOpaqueHandle("opaque_bad")
    ]) {
      expect(failure).toThrowError(TARGET_SECRET_SOURCE_ERROR);
      try { failure(); } catch (error) { expect(String(error)).not.toContain(sentinel); }
    }
  });
});
