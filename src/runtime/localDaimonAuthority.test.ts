import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadLocalDaimonRuntimeIdentity
} from "./localDaimonAuthority.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./daimon/contractManifest.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const tempDirectories: string[] = [];
const repository = "127.0.0.1:54321/noopolis/spawnfile-runtime-daimon";

const createIdentity = (): Record<string, unknown> => ({
  capability_receipt_sha256: digest("a"),
  development: {
    mode: "local-development",
    non_production: true,
    unpublished: true,
    unsigned: true
  },
  image_architecture: "amd64",
  image_config_digest: digest("b"),
  image_manifest_digest: digest("c"),
  image_reference: `${repository}@${digest("c")}`,
  manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256,
  registry_authority: "127.0.0.1:54321",
  version: "spawnfile.local-daimon-runtime-identity.v3"
});

const writeIdentity = async (identity: Record<string, unknown>): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-daimon-identity-"));
  tempDirectories.push(directory);
  const identityPath = path.join(directory, "identity.json");
  await writeFile(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  return identityPath;
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("local Daimon runtime authority", () => {
  it("loads an exact non-production identity bound to a registry manifest and receipt digest", async () => {
    const identityPath = await writeIdentity(createIdentity());

    await expect(loadLocalDaimonRuntimeIdentity(identityPath)).resolves.toEqual({
      capabilityReceipt: digest("a"),
      imageArchitecture: "amd64",
      imageConfigDigest: digest("b"),
      imageManifestDigest: digest("c"),
      imageReference: `${repository}@${digest("c")}`,
      manifestSha256: DAIMON_CONTRACT_MANIFEST_SHA256,
      registryAuthority: "127.0.0.1:54321"
    });
  });

  it("rejects a tag-only image", async () => {
    const identity = createIdentity();
    identity.image_reference = `${repository}:0.2.0-local`;

    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(identity))).rejects.toThrow(
      /invalid or incomplete/u
    );
  });

  it("rejects an arbitrary registry image even when digest-bound", async () => {
    const identity = createIdentity();
    identity.image_reference = `registry.invalid/daimon@${digest("c")}`;

    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(identity))).rejects.toThrow(
      /invalid or incomplete/u
    );
  });

  it("rejects non-loopback, missing, or mismatched registry authority", async () => {
    const remote = createIdentity(); remote.registry_authority = "registry.invalid:54321";
    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(remote))).rejects.toThrow(/invalid or incomplete/u);
    const missing = createIdentity(); delete missing.registry_authority;
    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(missing))).rejects.toThrow(/invalid or incomplete/u);
    const mismatched = createIdentity(); mismatched.registry_authority = "127.0.0.1:54322";
    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(mismatched))).rejects.toThrow(/invalid or incomplete/u);
  });

  it("rejects a missing capability receipt digest", async () => {
    const identity = createIdentity();
    delete identity.capability_receipt_sha256;

    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(identity))).rejects.toThrow(
      /invalid or incomplete/u
    );
  });

  it("rejects a local image built for any other Daimon contract manifest", async () => {
    const identity = createIdentity();
    identity.manifest_sha256 = digest("d");
    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(identity))).rejects.toThrow(/invalid or incomplete/u);
  });

  it("rejects a reference whose manifest digest disagrees with its identity field", async () => {
    const identity = createIdentity();
    identity.image_reference = `${repository}@${digest("e")}`;

    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(identity))).rejects.toThrow(
      /invalid or incomplete/u
    );
  });

  it("rejects a production-looking or extensible authority document", async () => {
    const production = createIdentity();
    production.development = {
      mode: "production",
      non_production: false,
      unpublished: false,
      unsigned: false
    };
    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(production))).rejects.toThrow(
      /invalid or incomplete/u
    );

    const extended = createIdentity();
    extended.image_override = "anything";
    await expect(loadLocalDaimonRuntimeIdentity(await writeIdentity(extended))).rejects.toThrow(
      /invalid or incomplete/u
    );
  });

  it("rejects relative authority paths", async () => {
    await expect(loadLocalDaimonRuntimeIdentity("identity.json")).rejects.toThrow(/absolute/u);
  });
});
