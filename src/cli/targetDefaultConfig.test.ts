import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePreparedEvidenceHelperReceipt } from "../evidenceExportHelper/index.js";
import {
  TARGET_DEFAULT_CONFIG_ERROR,
  loadTargetDefaultConfig,
  resolveTargetDefaultWorldReadinessConfig,
  type TargetDefaultConfigInputs
} from "./targetDefaultConfig.js";

const manifest = `sha256:${"a".repeat(64)}`;
const image = `sha256:${"b".repeat(64)}`;
const preparedHelper = parsePreparedEvidenceHelperReceipt({
  digest: `sha256:${"c".repeat(64)}`,
  handle: `opaque_${"d".repeat(64)}`,
  version: "spawnfile.target-evidence-export-helper.prepared.v1",
});
const mapping = {
  artifact_manifest_digest: manifest,
  image_digest: image,
  image_reference: `registry.example/spawn/helper@${image}`
};
const originalHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

const setup = async (): Promise<{
  destination: string;
  home: string;
  inputs: TargetDefaultConfigInputs;
}> => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-config-")));
  cleanup.push(temporary);
  const home = path.join(temporary, "home");
  const output = path.join(temporary, "output");
  await mkdir(home, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  process.env.SPAWNFILE_HOME = home;
  const destination = path.join(output, "evidence.tar");
  return {
    destination,
    home,
    inputs: {
      artifactMappings: [mapping],
      context: "prod_1",
      dockerCommand: "/usr/local/bin/docker",
      evidenceDestination: destination,
      helperArtifactManifestDigest: manifest,
      timeoutMs: 30_000
    }
  };
};

describe("private target default configuration", () => {
  it("derives exact private roots from SPAWNFILE_HOME and preserves explicit inputs", async () => {
    const value = await setup();
    process.env.SPAWNFILE_EVIDENCE_DESTINATION = "/must/not/be/read";
    const config = await loadTargetDefaultConfig(value.inputs);
    expect(config).toMatchObject({
      context: "prod_1",
      dockerCommand: "/usr/local/bin/docker",
      evidenceDestination: value.destination,
      timeoutMs: 30_000,
      helperArtifact: mapping
    });
    expect(config.paths).toEqual({
      root: path.join(value.home, "target"),
      journals: path.join(value.home, "target", "journals"),
      artifactIdentities: path.join(value.home, "target", "artifact-identities"),
      secretAuthority: path.join(value.home, "target", "secret-authority"),
      attachmentAuthority: path.join(value.home, "target", "attachment-authority"),
      worldAuthority: path.join(value.home, "target", "world-authority"),
      evidenceExport: path.join(value.home, "target", "evidence-export"),
      evidenceHelper: path.join(value.home, "target", "evidence-helper"),
      containerBundles: path.join(value.home, "target", "container-bundles")
    });
    for (const directory of Object.values(config.paths)) {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.paths)).toBe(true);
    expect(Object.isFrozen(config.artifactMappings)).toBe(true);
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      artifactMappings: [mapping], context: "prod_1", dockerCommand: "/usr/local/bin/docker",
      evidenceDestination: value.destination, helperArtifact: mapping, paths: config.paths,
      preparedArtifactMappings: [], timeoutMs: 30_000
    });
    expect(structuredClone(config)).toEqual(config);
    delete process.env.SPAWNFILE_EVIDENCE_DESTINATION;
  });

  it("admits a helper-free target configuration for operations that do not export evidence", async () => {
    const value = await setup();
    const { artifactMappings: _artifactMappings, helperArtifactManifestDigest: _helper, ...inputs } = value.inputs;
    const config = await loadTargetDefaultConfig(inputs);
    expect(config.artifactMappings).toEqual([]);
    expect(config.helperArtifact).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("helperArtifact");
  });

  it("accepts the local helper only as a paired opaque prepared receipt", async () => {
    const value = await setup();
    const { artifactMappings: _mappings, helperArtifactManifestDigest: _legacy, ...helperFree } = value.inputs;
    const config = await loadTargetDefaultConfig({
      ...helperFree,
      evidenceHelperBaseImage: "node:22-bookworm-slim",
      preparedEvidenceHelper: preparedHelper,
    });
    expect(config.evidenceHelperBaseImage).toBe("node:22-bookworm-slim");
    expect(config.preparedEvidenceHelper).toEqual(preparedHelper);
    for (const partial of [
      { ...helperFree, evidenceHelperBaseImage: "node:22-bookworm-slim" },
      { ...helperFree, preparedEvidenceHelper: preparedHelper },
      { ...helperFree, evidenceHelperBaseImage: "sha256:" + "e".repeat(64), preparedEvidenceHelper: preparedHelper },
      { ...helperFree, evidenceHelperBaseImage: "node:22-bookworm-slim", preparedEvidenceHelper: {
        ...preparedHelper, handle: "opaque_short",
      } },
    ]) {
      await expect(loadTargetDefaultConfig(partial as never)).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    }
  });

  it("keeps an explicit container-bundle authority across fresh per-run homes only", async () => {
    const first = await setup();
    const durable = path.join(path.dirname(first.home), "durable-container-bundles");
    await mkdir(durable, { mode: 0o700 });
    const firstConfig = await loadTargetDefaultConfig({
      ...first.inputs,
      containerBundleStoreRoot: durable
    });
    await writeFile(path.join(firstConfig.paths.containerBundles, "durable-marker"), "bundle", { mode: 0o600 });
    await writeFile(path.join(firstConfig.paths.secretAuthority, "run-secret-marker"), "secret", { mode: 0o600 });

    const second = await setup();
    const secondConfig = await loadTargetDefaultConfig({
      ...second.inputs,
      containerBundleStoreRoot: durable
    });
    expect(secondConfig.paths.containerBundles).toBe(durable);
    expect(await readdir(secondConfig.paths.containerBundles)).toContain("durable-marker");
    expect(secondConfig.paths.secretAuthority).not.toBe(firstConfig.paths.secretAuthority);
    expect(secondConfig.paths.journals).not.toBe(firstConfig.paths.journals);
    expect(await readdir(secondConfig.paths.secretAuthority)).toEqual([]);
    expect(await readdir(secondConfig.paths.journals)).toEqual([]);
    expect(JSON.stringify(secondConfig)).not.toContain("run-secret-marker");
  });

  it("repairs owned root modes but rejects symlinked roots", async () => {
    const repair = await setup();
    await mkdir(path.join(repair.home, "target"), { mode: 0o755 });
    await loadTargetDefaultConfig(repair.inputs);
    expect((await lstat(path.join(repair.home, "target"))).mode & 0o777).toBe(0o700);

    const hostile = await setup();
    const foreign = path.join(path.dirname(hostile.home), "foreign");
    await mkdir(foreign, { mode: 0o700 });
    await symlink(foreign, path.join(hostile.home, "target"));
    await expect(loadTargetDefaultConfig(hostile.inputs))
      .rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
  });

  it("rejects malformed, aliased, root, and lifecycle-overlapping bundle authorities", async () => {
    const value = await setup();
    const parent = path.dirname(value.home);
    const physical = path.join(parent, "physical-bundle-root");
    const link = path.join(parent, "bundle-root-link");
    await mkdir(physical, { mode: 0o700 });
    await symlink(physical, link);
    for (const containerBundleStoreRoot of [
      "relative/container-bundles",
      path.parse(value.home).root,
      link,
      path.join(value.home, "target"),
      path.join(value.home, "target", "secret-authority"),
      path.join(value.home, "target", "container-bundles", "nested")
    ]) {
      await expect(loadTargetDefaultConfig({
        ...value.inputs,
        containerBundleStoreRoot
      })).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    }
  });

  it("rejects proxy, accessor, extra, and non-enumerable invocation graphs", async () => {
    const value = await setup();
    let reads = 0;
    const accessor = { ...value.inputs } as Record<string, unknown>;
    Object.defineProperty(accessor, "context", {
      enumerable: true,
      get: () => { reads += 1; return "prod_1"; }
    });
    await expect(loadTargetDefaultConfig(accessor as never)).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    await expect(loadTargetDefaultConfig(new Proxy(value.inputs, {}) as never))
      .rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    await expect(loadTargetDefaultConfig({ ...value.inputs, extra: true } as never))
      .rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    const hidden = { ...value.inputs } as Record<string, unknown>;
    Object.defineProperty(hidden, "timeoutMs", { enumerable: false, value: 30_000 });
    await expect(loadTargetDefaultConfig(hidden as never)).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    expect(reads).toBe(0);
  });

  it("rejects malformed, duplicate, hostile, and oversized mapping graphs", async () => {
    for (const artifactMappings of [
      [{ ...mapping, extra: true }],
      [mapping, mapping],
      new Proxy([mapping], {}),
      [{ ...mapping, image_reference: `${mapping.image_reference}\n` }],
      Array.from({ length: 33 }, () => mapping)
    ]) {
      const value = await setup();
      await expect(loadTargetDefaultConfig({ ...value.inputs, artifactMappings } as never))
        .rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    }
  });

  it("admits prepared mappings only as unique manifest/bundle/policy correlations", async () => {
    const value = await setup();
    const prepared = {
      archive_digest: `sha256:${"b".repeat(64)}`,
      artifact_manifest_digest: `sha256:${"c".repeat(64)}`,
      base_image_config_digest: `sha256:${"d".repeat(64)}`,
      build_policy_digest: `sha256:${"e".repeat(64)}`,
      bundle_digest: `sha256:${"f".repeat(64)}`,
      entrypoint: "bundle.json",
      launcher_digest: `sha256:${"1".repeat(64)}`,
      network_alias: "world",
      platform: { architecture: "amd64", os: "linux" } as const,
      platform_digest: `sha256:${"2".repeat(64)}`
    };
    await expect(loadTargetDefaultConfig({ ...value.inputs, preparedArtifactMappings: [prepared] }))
      .resolves.toMatchObject({ preparedArtifactMappings: [prepared] });
    for (const preparedArtifactMappings of [
      [{ ...prepared, config_id: `sha256:${"3".repeat(64)}` }],
      [prepared, prepared],
      [{ ...prepared, artifact_manifest_digest: manifest }],
      [{ ...prepared, bundle_digest: "wrong" }]
    ]) {
      await expect(loadTargetDefaultConfig({ ...value.inputs, preparedArtifactMappings } as never))
        .rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    }
  });

  it("rejects unsafe destinations and missing helpers", async () => {
    const normalized = await setup();
    await expect(loadTargetDefaultConfig({
      ...normalized.inputs,
      evidenceDestination: `${path.dirname(normalized.destination)}/../evidence.tar`
    })).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    const publicDestination = await setup();
    await chmod(path.dirname(publicDestination.destination), 0o755);
    await expect(loadTargetDefaultConfig(publicDestination.inputs))
      .rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    const missing = await setup();
    await expect(loadTargetDefaultConfig({
      ...missing.inputs, helperArtifactManifestDigest: `sha256:${"c".repeat(64)}`
    })).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    const partial = await setup();
    const { helperArtifactManifestDigest: _helper, ...withoutHelper } = partial.inputs;
    await expect(loadTargetDefaultConfig(withoutHelper)).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    const withoutMappings = await setup();
    const { artifactMappings: _mappings, ...withoutArtifactMappings } = withoutMappings.inputs;
    await expect(loadTargetDefaultConfig(withoutArtifactMappings)).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
  });

  it("strictly bounds context, command, timeout, digest, and destination", async () => {
    const value = await setup();
    for (const changes of [
      { context: "Bad Context" },
      { context: `a${"b".repeat(64)}` },
      { dockerCommand: "docker command" },
      { dockerCommand: `/${"x".repeat(4_097)}` },
      { timeoutMs: 0 },
      { timeoutMs: 120_001 },
      { timeoutMs: 1.5 },
      { helperArtifactManifestDigest: `${manifest}\n` },
      { evidenceDestination: `/${"x".repeat(4_097)}` }
    ]) {
      await expect(loadTargetDefaultConfig({ ...value.inputs, ...changes }))
        .rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    }
  });

  it("rejects invalid read-only query controls without preparing target roots", async () => {
    const value = await setup();
    expect(await readdir(value.home)).toEqual([]);
    for (const changes of [
      { context: "Bad Context" },
      { dockerCommand: "docker command" },
      { timeoutMs: 0 },
      { timeoutMs: 120_001 }
    ]) {
      expect(() => resolveTargetDefaultWorldReadinessConfig({
        ...value.inputs,
        ...changes
      })).toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    }
    expect(await readdir(value.home)).toEqual([]);
  });

  it("has no production resolver, secret, provider, or fallback input", async () => {
    const value = await setup();
    const sentinel = "private-secret-sentinel";
    await expect(loadTargetDefaultConfig({
      ...value.inputs,
      secretResolver: { resolve: vi.fn(async () => ({ value: sentinel })) }
    } as never)).rejects.toThrow(TARGET_DEFAULT_CONFIG_ERROR);
    const clean = await loadTargetDefaultConfig(value.inputs);
    expect(JSON.stringify(clean)).not.toContain(sentinel);
    expect(Object.hasOwn(clean, "resolvers")).toBe(false);
    expect(await lstat(clean.paths.secretAuthority).then(() => true)).toBe(true);
  });
});
