import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle } from "./contracts.js";
import {
  DOCKER_ARTIFACT_ERROR,
  initializeDockerArtifactIdentityStore,
  type DockerConfigArtifactIdentityBinding,
  type DockerOciArtifactIdentityBinding,
} from "./dockerArtifactsProvider.js";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-artifact-validation-")));
  roots.push(value);
  return value;
};

afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true }))));

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const handle = (character: string) => parseOpaqueTargetHandle(`opaque_${character.repeat(64)}`);
const imageDigest = digest("b");
const oci = (): DockerOciArtifactIdentityBinding => ({
  artifactManifestDigest: digest("a"),
  imageDigest,
  imageReference: `registry.example/world@${imageDigest}`,
  operationHandle: handle("c"),
  requestDigest: digest("d"),
  resultHandle: handle("e"),
  selectedTargetHandle: handle("f"),
});
const config = (): DockerConfigArtifactIdentityBinding => ({
  archiveDigest: digest("1"),
  artifactManifestDigest: digest("2"),
  baseImageConfigDigest: digest("3"),
  buildPolicyDigest: digest("4"),
  bundleDigest: digest("5"),
  configId: digest("6"),
  daemonEpoch: digest("7"),
  entrypoint: "bundle.json",
  gcTag: `spfb_${"8".repeat(58)}`,
  identityKind: "docker_image_config_digest",
  launcherDigest: digest("9"),
  networkAlias: "world",
  operationHandle: handle("a"),
  platform: { architecture: "amd64", os: "linux" },
  platformDigest: digest("b"),
  preparedOperationHandle: handle("b"),
  preparedRequestDigest: digest("c"),
  requestDigest: digest("d"),
  resultHandle: handle("e"),
  selectedTargetHandle: handle("f"),
});

describe("Docker artifact identity-store validation", () => {
  it("rejects malformed roots and non-directory ancestors before publication", async () => {
    for (const hostile of [null, "", "x".repeat(4_097)]) {
      await expect(initializeDockerArtifactIdentityStore(hostile)).rejects.toThrow(DOCKER_ARTIFACT_ERROR);
    }

    const directory = await root();
    const file = path.join(directory, "not-a-directory");
    await writeFile(file, "private", { mode: 0o600 });
    await expect(initializeDockerArtifactIdentityStore(path.join(file, "identities")))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);
  });

  it("rejects exotic object shapes and every private identity-union discriminator drift", async () => {
    const store = await initializeDockerArtifactIdentityStore(path.join(await root(), "identities"));
    const base = oci();
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, base);
    const accessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessor, "requestDigest", { enumerable: true, get: () => base.requestDigest });

    for (const hostile of [
      null,
      [],
      nullPrototype,
      accessor,
      { ...base, requestDigest: "not-a-digest" },
      { ...base, artifactManifestDigest: "not-a-digest" },
      { ...base, extra: "field" },
      { ...base, identityKind: "unknown" },
    ]) await expect(store.bind(hostile as never)).rejects.toThrow(DOCKER_ARTIFACT_ERROR);

    await expect(store.bind({ ...base, identityKind: "oci_image_manifest" })).resolves.toBeUndefined();
    await expect(store.bind({ ...config(), platform: undefined } as never)).rejects.toThrow(DOCKER_ARTIFACT_ERROR);
    await expect(store.bind({ ...config(), platform: { architecture: "s390x", os: "linux" } } as never))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);
    await expect(store.bind({ ...config(), platform: { architecture: "arm64", os: "darwin" } } as never))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);
  });

  it("rejects noncanonical stored bytes, unknown stored variants, and lookup correlation drift", async () => {
    const directory = path.join(await root(), "identities");
    const store = await initializeDockerArtifactIdentityStore(directory);
    const binding = oci();
    await store.bind(binding);
    const record = path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".identity.json"))!);
    const canonical = await readFile(record, "utf8");

    await writeFile(record, `${canonical}\n`, "utf8");
    await chmod(record, 0o600);
    await expect(store.resolveOperation(binding.operationHandle, binding.requestDigest))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);

    const unknown = JSON.parse(canonical) as Record<string, unknown>;
    unknown.identity_kind = "unknown";
    await writeFile(record, JSON.stringify(unknown), "utf8");
    await expect(store.resolveOperation(binding.operationHandle, binding.requestDigest))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);

    const driftedOperation = handle("9");
    await writeFile(record, canonical.replace(binding.operationHandle, driftedOperation), "utf8");
    await expect(store.resolveOperation(binding.operationHandle, binding.requestDigest))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);
    await expect(store.resolveOperation(binding.operationHandle, "not-a-digest"))
      .rejects.toThrow(DOCKER_ARTIFACT_ERROR);
  });
});
