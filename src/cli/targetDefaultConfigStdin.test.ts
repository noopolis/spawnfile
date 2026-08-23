import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_TARGET_DEFAULT_CONFIG_STDIN_BYTES,
  readTargetDefaultConfigStdin,
  readTargetLookupConfigStdin,
  readTargetWorldReadinessConfigStdin,
  TARGET_DEFAULT_CONFIG_STDIN_ERROR,
  TARGET_DEFAULT_CONFIG_STDIN_VERSION,
  TARGET_LOOKUP_CONFIG_STDIN_VERSION
} from "./targetDefaultConfigStdin.js";

const roots: string[] = [];
const originalHome = process.env.SPAWNFILE_HOME;
const stdin = (value: string | Uint8Array) => (async function* (): AsyncGenerator<string | Uint8Array> {
  yield value;
})();
const trackedInput = (chunks: readonly (string | Uint8Array)[]) => {
  let next = 0;
  let returns = 0;
  const iterable: AsyncIterable<string | Uint8Array> & { returns: () => number } = {
    [Symbol.asyncIterator]: () => ({
      next: async () => next < chunks.length
        ? { done: false as const, value: chunks[next++]! }
        : { done: true as const, value: undefined },
      return: async () => {
        returns += 1;
        return { done: true as const, value: undefined };
      }
    }),
    returns: () => returns
  };
  return iterable;
};
const config = (destination: string) => ({
  artifactMappings: [{
    artifact_manifest_digest: `sha256:${"a".repeat(64)}`,
    image_digest: `sha256:${"b".repeat(64)}`,
    image_reference: `registry.example/spawn/helper@sha256:${"b".repeat(64)}`
  }],
  context: "gpu_host", dockerCommand: "docker", evidenceDestination: destination,
  helperArtifactManifestDigest: `sha256:${"a".repeat(64)}`, timeoutMs: 30_000,
  version: TARGET_DEFAULT_CONFIG_STDIN_VERSION
});
const preparedHelper = Object.freeze({
  digest: `sha256:${"c".repeat(64)}`,
  handle: `opaque_${"d".repeat(64)}`,
  version: "spawnfile.target-evidence-export-helper.prepared.v1",
});
const setup = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-target-config-stdin-")));
  roots.push(root);
  const home = path.join(root, "home"); const output = path.join(root, "output");
  await mkdir(home, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
  process.env.SPAWNFILE_HOME = home;
  return JSON.stringify(config(path.join(output, "evidence.tar")));
};

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("readTargetDefaultConfigStdin", () => {
  it("accepts one bounded versioned config document", async () => {
    const value = await setup();
    await expect(readTargetDefaultConfigStdin(stdin(value))).resolves.toMatchObject({
      context: "gpu_host", dockerCommand: "docker", timeoutMs: 30_000
    });
  });

  it("accepts only the explicit snake-case persistent bundle authority field", async () => {
    const value = JSON.parse(await setup()) as Record<string, unknown>;
    const destination = value.evidenceDestination as string;
    const bundleRoot = path.join(path.dirname(path.dirname(destination)), "bundle-cache");
    await mkdir(bundleRoot, { mode: 0o700 });
    value.container_bundle_store_root = bundleRoot;
    const loaded = await readTargetDefaultConfigStdin(stdin(JSON.stringify(value)));
    expect(loaded.paths.containerBundles).toBe(bundleRoot);
    await expect(readTargetDefaultConfigStdin(stdin(JSON.stringify({
      ...value,
      containerBundleStoreRoot: bundleRoot
    })))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
  });

  it("accepts a helper-free configuration but rejects a partial helper authority", async () => {
    const value = JSON.parse(await setup()) as Record<string, unknown>;
    delete value.artifactMappings;
    delete value.helperArtifactManifestDigest;
    const loaded = await readTargetDefaultConfigStdin(stdin(JSON.stringify(value)));
    expect(loaded).toMatchObject({ artifactMappings: [], context: "gpu_host" });
    expect(Object.hasOwn(loaded, "helperArtifact")).toBe(false);
    const partial = { ...value, artifactMappings: config("/private/evidence.tar").artifactMappings };
    await expect(readTargetDefaultConfigStdin(stdin(JSON.stringify(partial))))
      .rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
  });

  it("accepts the paired local prepared receipt but no caller-owned authority seam", async () => {
    const value = JSON.parse(await setup()) as Record<string, unknown>;
    delete value.artifactMappings;
    delete value.helperArtifactManifestDigest;
    value.evidenceHelperBaseImage = "node:22-bookworm-slim";
    value.preparedEvidenceHelper = preparedHelper;
    await expect(readTargetDefaultConfigStdin(stdin(JSON.stringify(value))))
      .resolves.toMatchObject({ evidenceHelperBaseImage: "node:22-bookworm-slim", preparedEvidenceHelper: preparedHelper });
    const partial = { ...value };
    delete partial.preparedEvidenceHelper;
    await expect(readTargetDefaultConfigStdin(stdin(JSON.stringify(partial))))
      .rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin(stdin(JSON.stringify({
      ...value, evidenceHelperAuthority: "/caller/owned/authority.json",
    })))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
  });

  it("rejects empty, non-stdin bytes, BOM, malformed, trailing, and oversized input", async () => {
    await expect(readTargetDefaultConfigStdin((async function* () {})())).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin((async function* () { yield 1; })())).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin(stdin("\uFEFF{}"))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin(stdin("{"))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin(stdin("{} {}"))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin(stdin(" ".repeat(MAX_TARGET_DEFAULT_CONFIG_STDIN_BYTES + 1))))
      .rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
  });

  it("bounds hostile iterators, closes them once, and rejects malformed UTF-8", async () => {
    const zero = trackedInput([new Uint8Array()]);
    await expect(readTargetDefaultConfigStdin(zero)).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    expect(zero.returns()).toBe(1);

    const overLimit = trackedInput([new Uint8Array(MAX_TARGET_DEFAULT_CONFIG_STDIN_BYTES + 1)]);
    await expect(readTargetDefaultConfigStdin(overLimit)).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    expect(overLimit.returns()).toBe(1);

    await expect(readTargetDefaultConfigStdin((async function* () {
      throw new Error("untrusted iterator failure");
    })())).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin(stdin(new Uint8Array([0xff]))))
      .rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
  });

  it("rejects duplicate nested and escaped-equivalent keys before config initialization", async () => {
    const value = await setup();
    const duplicate = value.replace('"image_digest":', '"image_digest":"wrong","image_digest":');
    const escaped = value.replace('"image_digest":', '"image_\\u0064igest":"wrong","image_digest":');
    const nested = value.replace('"context":"gpu_host"', '"context":"gpu_host","nested":{"x":1,"x":2}');
    await expect(readTargetDefaultConfigStdin(stdin(duplicate))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin(stdin(escaped))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    await expect(readTargetDefaultConfigStdin(stdin(nested))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
  });

  it("rejects unsafe configuration before an authority session can exist", async () => {
    const value = await setup();
    const parsed = JSON.parse(value) as { evidenceDestination: string };
    await chmod(path.dirname(parsed.evidenceDestination), 0o755);
    await expect(readTargetDefaultConfigStdin(stdin(value))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
  });

  it("rejects relative, filesystem-root, and symlinked persistent bundle authorities", async () => {
    const value = JSON.parse(await setup()) as Record<string, unknown>;
    const destination = value.evidenceDestination as string;
    const parent = path.dirname(path.dirname(destination));
    const physical = path.join(parent, "physical-bundle-cache");
    const link = path.join(parent, "bundle-cache-link");
    await mkdir(physical, { mode: 0o700 });
    await symlink(physical, link);
    for (const container_bundle_store_root of [
      "relative/bundle-cache",
      path.parse(parent).root,
      link
    ]) {
      await expect(readTargetDefaultConfigStdin(stdin(JSON.stringify({
        ...value,
        container_bundle_store_root
      })))).rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    }
  });
});

describe("readTargetLookupConfigStdin", () => {
  it("accepts only the bounded read-only context document without filesystem writes", async () => {
    await setup();
    const home = process.env.SPAWNFILE_HOME!;
    expect(await readdir(home)).toEqual([]);
    await expect(readTargetLookupConfigStdin(stdin(JSON.stringify({
      context: "gpu_host", version: TARGET_LOOKUP_CONFIG_STDIN_VERSION
    })))).resolves.toEqual({ context: "gpu_host" });
    expect(await readdir(home)).toEqual([]);
  });

  it("rejects default/provider config, selection data, duplicate keys, and invalid context", async () => {
    const defaultConfig = await setup();
    for (const value of [
      defaultConfig,
      '{"context":"gpu_host","context":"other","version":"spawnfile.target-lookup-config.v1"}',
      '{"context":"GPU host","version":"spawnfile.target-lookup-config.v1"}',
      '{"context":"gpu_host","selected_target":{},"version":"spawnfile.target-lookup-config.v1"}'
    ]) {
      await expect(readTargetLookupConfigStdin(stdin(value)))
        .rejects.toThrow(TARGET_DEFAULT_CONFIG_STDIN_ERROR);
    }
  });
});

describe("readTargetWorldReadinessConfigStdin", () => {
  it("resolves the private read authority without preparing any target roots", async () => {
    const value = await setup();
    const home = process.env.SPAWNFILE_HOME!;
    expect(await readdir(home)).toEqual([]);
    await expect(readTargetWorldReadinessConfigStdin(stdin(value))).resolves.toMatchObject({
      context: "gpu_host",
      dockerCommand: "docker",
      paths: { worldAuthority: path.join(home, "target", "world-authority") },
      timeoutMs: 30_000
    });
    expect(await readdir(home)).toEqual([]);
  });
});
