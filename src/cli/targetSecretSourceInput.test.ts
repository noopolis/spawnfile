import { appendFile, chmod, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_TARGET_SECRET_SOURCE_SECRET_BYTES, TARGET_SECRET_SOURCE_ERROR, createCanonicalTargetSecretSourceJson } from "../auth/targetSecretSourceRecordCommon.js";
import {
  TARGET_SECRET_SOURCE_RECEIPT_VERSION,
  TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION,
  TARGET_SECRET_SOURCE_REQUEST_VERSION,
  createTargetSecretSourceReceiptBytes,
  parseTargetSecretSourceGrantRequestBytes,
  parseTargetSecretSourceRequestBytes,
  readBoundedTargetSecretStdin,
  readTargetSecretSourceRequestFile
} from "./targetSecretSourceInput.js";

const source = `opaque_${"ab".repeat(16)}`;
const iterable = async function* (chunks: unknown[]): AsyncIterable<unknown> {
  for (const chunk of chunks) yield chunk;
};

describe("targetSecretSourceInput", () => {
  it("reads injected stdin once, preserves binary bytes, and clears owned chunks", async () => {
    const first = new Uint8Array([0, 1]);
    const second = new Uint8Array([2, 255]);
    const result = await readBoundedTargetSecretStdin(iterable([first, second]), MAX_TARGET_SECRET_SOURCE_SECRET_BYTES);
    expect(result).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(first).toEqual(new Uint8Array([0, 1]));
    expect(second).toEqual(new Uint8Array([2, 255]));
    result.fill(0);
  });

  it("rejects empty, oversized, malformed, and throwing stdin with one bounded error", async () => {
    const throwing = async function* (): AsyncIterable<unknown> { yield new Uint8Array([1]); throw new Error("sentinel"); };
    for (const input of [
      iterable([]),
      iterable([new Uint8Array(4)]),
      iterable([{}]),
      throwing()
    ]) {
      await expect(readBoundedTargetSecretStdin(input, 3))
        .rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    }
    await expect(readBoundedTargetSecretStdin(iterable([new Uint8Array([1])]), MAX_TARGET_SECRET_SOURCE_SECRET_BYTES + 1))
      .rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("parses only the exact canonical source request", () => {
    const bytes = createCanonicalTargetSecretSourceJson({
      source_handle: source,
      version: TARGET_SECRET_SOURCE_REQUEST_VERSION
    });
    expect(parseTargetSecretSourceRequestBytes(bytes)).toEqual({
      source_handle: source,
      version: TARGET_SECRET_SOURCE_REQUEST_VERSION
    });
    for (const raw of [
      { source_handle: source, version: "wrong" },
      { extra: true, source_handle: source, version: TARGET_SECRET_SOURCE_REQUEST_VERSION }
    ]) expect(() => parseTargetSecretSourceRequestBytes(createCanonicalTargetSecretSourceJson(raw)))
      .toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("requires the exact versioned grant request envelope before schema parsing", () => {
    const grant = {
      descriptor_digest: `sha256:${"a".repeat(64)}`, name: "token", run_id: "run-1", scope: "world",
      selected_target: {
        fingerprint: `sha256:${"b".repeat(32)}`, handle: source,
        version: "spawnfile.target-resource.selected-target.v1"
      },
      source_handle: `opaque_${"cd".repeat(16)}`
    };
    const bytes = createCanonicalTargetSecretSourceJson({
      grant, version: TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION
    });
    expect(parseTargetSecretSourceGrantRequestBytes(bytes)).toEqual(grant);
    for (const raw of [{ grant }, { grant, version: "wrong" }, {
      grant, extra: true, version: TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION
    }]) expect(() => parseTargetSecretSourceGrantRequestBytes(createCanonicalTargetSecretSourceJson(raw)))
      .toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("normalizes missing/non-file and growing or truncated request files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-secret-input-"));
    try {
      const file = path.join(directory, "request.json");
      const bytes = createCanonicalTargetSecretSourceJson({
        source_handle: source, version: TARGET_SECRET_SOURCE_REQUEST_VERSION
      });
      await expect(readTargetSecretSourceRequestFile(path.join(directory, "missing"))).rejects
        .toThrow(TARGET_SECRET_SOURCE_ERROR);
      await expect(readTargetSecretSourceRequestFile(directory)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      await writeFile(file, bytes);
      await chmod(file, 0o000);
      await expect(readTargetSecretSourceRequestFile(file)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      await chmod(file, 0o600);
      await expect(readTargetSecretSourceRequestFile(file, {
        beforeReadForTest: () => appendFile(file, new Uint8Array([32]))
      })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      await writeFile(file, bytes);
      await expect(readTargetSecretSourceRequestFile(file, {
        beforeReadForTest: () => truncate(file, 1)
      })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits canonical secret-free receipt content and the CLI stream adds exactly one LF", () => {
    for (const kind of ["author", "grant", "revoke-grant", "revoke-version", "rotate"] as const) {
      const output = createTargetSecretSourceReceiptBytes({ kind, source_handle: source });
      const content = new TextDecoder().decode(output);
      expect(content).toBe(
        `{"kind":"${kind}","source_handle":"${source}","version":"${TARGET_SECRET_SOURCE_RECEIPT_VERSION}"}`
      );
      expect(`${content}\n`).toMatch(/[^\n]\n$/u);
      expect(`${content}\n`).not.toContain("\n\n");
      expect(content).not.toContain('"secret":');
    }
  });

  it("rejects extra and accessor receipt fields without reflecting hostile errors", () => {
    expect(() => createTargetSecretSourceReceiptBytes({
      kind: "author", source_handle: source, extra: true
    } as never)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    const accessor = {};
    Object.defineProperty(accessor, "kind", { enumerable: true, get: () => { throw new Error("sentinel"); } });
    Object.defineProperty(accessor, "source_handle", { enumerable: true, value: source });
    try { createTargetSecretSourceReceiptBytes(accessor as never); } catch (error) {
      expect(String(error)).toBe(`Error: ${TARGET_SECRET_SOURCE_ERROR}`);
      expect(String(error)).not.toContain("sentinel");
    }
    let accesses = 0;
    const validAccessor = { source_handle: source };
    Object.defineProperty(validAccessor, "kind", {
      enumerable: true,
      get: () => {
        accesses += 1;
        return "author";
      }
    });
    expect(() => createTargetSecretSourceReceiptBytes(validAccessor as never)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(accesses).toBe(0);
    let proxyReads = 0;
    const proxy = new Proxy({ kind: "author", source_handle: source }, {
      get: (target, property, receiver) => {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => createTargetSecretSourceReceiptBytes(proxy as never)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(proxyReads).toBe(0);
  });
});
