import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createPublishedDaimonCapabilityReceipt,
  createPublishedIdentity,
  parseDaimonPublishInputs,
  renderRuntimesYamlPin,
  resolvePublishedRepository,
  resolvePublishedTag
} from "./daimon-publish-inputs.ts";
import { createDaimonImageBuildArgs, tagExists } from "./publish-daimon-runtime.ts";

const digest = (character: string, length = 64): string => character.repeat(length);
const checkedIn = (): Record<string, unknown> =>
  JSON.parse(readFileSync("runtime-images/daimon/publish-inputs.json", "utf8")) as Record<string, unknown>;

test("checked-in publish inputs pin a full Daimon commit, both architectures, and explicit CLI digests", () => {
  const inputs = parseDaimonPublishInputs(checkedIn());
  assert.match(inputs.daimon.commit, /^[a-f0-9]{40}$/u);
  assert.deepEqual(inputs.platforms, ["amd64", "arm64"]);
  assert.equal(`${inputs.registry}/${inputs.image}`, "docker.io/noopolis/spawnfile-runtime-daimon");
  assert.equal(resolvePublishedTag(inputs), `${inputs.daimon.package_version}-${inputs.daimon.commit.slice(0, 7)}`);
  assert.notEqual(resolvePublishedTag(inputs), "latest");
});

test("publish inputs reject floating or credential-bearing pins", () => {
  type Mutable = {
    agy: { platforms: Record<string, { url: string } | undefined> };
    codex: { executable_sha256: string };
    daimon: { commit: string };
    extra?: boolean;
    platforms: string[];
  };
  const mutate = (patch: (value: Mutable) => void): Record<string, unknown> => {
    const value = structuredClone(checkedIn()) as unknown as Mutable;
    patch(value);
    return value as unknown as Record<string, unknown>;
  };
  assert.throws(() => parseDaimonPublishInputs(mutate((value) => { value.daimon.commit = "main"; })), /daimon\.commit/u);
  assert.throws(() => parseDaimonPublishInputs(mutate((value) => { value.agy.platforms.arm64!.url = "https://u:p@example.invalid/a.tgz"; })), /credential-free/u);
  assert.throws(() => parseDaimonPublishInputs(mutate((value) => { delete value.agy.platforms.arm64; })), /agy\.platforms\.arm64/u);
  assert.throws(() => parseDaimonPublishInputs(mutate((value) => { value.codex.executable_sha256 = "latest"; })), /codex\.executable_sha256/u);
  assert.throws(() => parseDaimonPublishInputs(mutate((value) => { value.platforms = ["amd64", "amd64"]; })), /platforms/u);
  assert.throws(() => parseDaimonPublishInputs(mutate((value) => { value.extra = true; })), /exactly/u);
});

test("publish repository override must be a bare repository", () => {
  const inputs = parseDaimonPublishInputs(checkedIn());
  assert.equal(resolvePublishedRepository(inputs), "docker.io/noopolis/spawnfile-runtime-daimon");
  assert.equal(resolvePublishedRepository(inputs, "127.0.0.1:5000/noopolis/spawnfile-runtime-daimon"), "127.0.0.1:5000/noopolis/spawnfile-runtime-daimon");
  assert.throws(() => resolvePublishedRepository(inputs, "docker.io/noopolis/spawnfile-runtime-daimon:latest"), /without tag/u);
  assert.throws(() => resolvePublishedRepository(inputs, `docker.io/noopolis/spawnfile-runtime-daimon@sha256:${digest("a")}`), /without tag/u);
});

test("published receipt keeps the verified shape but records CI provenance, not local development", () => {
  const inputs = parseDaimonPublishInputs(checkedIn());
  const receipt = createPublishedDaimonCapabilityReceipt({
    architecture: "arm64",
    artifacts: {
      agy: { archive_sha512: `sha512:${digest("b", 128)}`, executable_sha256: `sha256:${digest("a")}`, url: "https://example.invalid/agy.tgz", version: "1" },
      codex: { executable_sha256: `sha256:${digest("c")}` },
      grok: { executable_sha256: `sha256:${digest("d")}`, url: "https://example.invalid/grok", version: "2" }
    },
    manifestSha256: `sha256:${digest("e")}`,
    packageSha256: `sha256:${digest("f")}`,
    sourceSha256: `sha256:${digest("0")}`
  }, inputs.daimon);
  assert.equal(receipt.version, "spawnfile.daimon-runtime-capability-receipt.v1");
  assert.equal(receipt.architecture, "arm64");
  assert.equal(receipt.provenance.mode, "ci-published");
  assert.equal(receipt.provenance.source.commit, inputs.daimon.commit);
  assert.equal("non_production" in receipt.provenance, false);
  assert.equal("unpublished" in receipt.provenance, false);

  const args = createDaimonImageBuildArgs(receipt, Buffer.from("{}\n"), inputs.codex.version);
  const named = new Map(args.filter((_, index) => index % 2 === 1).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  assert.equal(named.get("DAIMON_DEPENDENCY_MODE"), "registry");
  assert.equal(named.get("GROK_CLI_SHA256"), digest("d"));
  assert.equal(named.get("AGY_CLI_SHA512"), digest("b", 128));
  assert.equal(named.get("CODEX_CLI_VERSION"), inputs.codex.version);
  assert.equal(named.get("DAIMON_CAPABILITY_RECEIPT_BASE64"), Buffer.from("{}\n").toString("base64"));
  // Every ARG the runtime Dockerfile requires must be supplied.
  const dockerfile = readFileSync("runtime-images/daimon/Dockerfile", "utf8");
  for (const required of [...dockerfile.matchAll(/test -n "\$\{([A-Z0-9_]+)\}"/gu)].map((match) => match[1])) {
    if (required === "TARGETARCH") continue;
    assert.ok(named.has(required ?? ""), `missing build arg ${required}`);
  }
});

test("published identity binds every platform receipt and renders the runtimes.yaml pin", () => {
  const inputs = parseDaimonPublishInputs(checkedIn());
  const platforms = {
    amd64: { capability_receipt_sha256: `sha256:${digest("1")}`, image_manifest_digest: `sha256:${digest("2")}`, package_sha256: `sha256:${digest("3")}` },
    arm64: { capability_receipt_sha256: `sha256:${digest("4")}`, image_manifest_digest: `sha256:${digest("5")}`, package_sha256: `sha256:${digest("6")}` }
  };
  const identity = createPublishedIdentity(inputs, {
    contractManifestSha256: `sha256:${digest("7")}`, digest: `sha256:${digest("8")}`, platforms,
    repository: "docker.io/noopolis/spawnfile-runtime-daimon", tag: "0.2.0-abcdef0"
  });
  assert.equal(identity.version, "spawnfile.published-daimon-runtime-identity.v1");
  assert.equal(identity.image_reference, `docker.io/noopolis/spawnfile-runtime-daimon@sha256:${digest("8")}`);
  assert.deepEqual(identity.capability_receipts, { amd64: `sha256:${digest("1")}`, arm64: `sha256:${digest("4")}` });
  const pin = renderRuntimesYamlPin(identity);
  assert.match(pin, new RegExp(`digest: sha256:${digest("8")}`, "u"));
  assert.match(pin, new RegExp(`arm64: sha256:${digest("4")}`, "u"));
  assert.throws(() => createPublishedIdentity(inputs, {
    contractManifestSha256: `sha256:${digest("7")}`, digest: `sha256:${digest("8")}`, platforms: { amd64: platforms.amd64 },
    repository: "docker.io/noopolis/spawnfile-runtime-daimon", tag: "0.2.0-abcdef0"
  }), /arm64/u);
});

test("published identity and pin follow a repository override instead of the default image", () => {
  const inputs = parseDaimonPublishInputs(checkedIn());
  const platform = { capability_receipt_sha256: `sha256:${digest("1")}`, image_manifest_digest: `sha256:${digest("2")}`, package_sha256: `sha256:${digest("3")}` };
  const identity = createPublishedIdentity(inputs, {
    contractManifestSha256: `sha256:${digest("7")}`, digest: `sha256:${digest("8")}`, platforms: { amd64: platform, arm64: platform },
    repository: "127.0.0.1:5000/acme/daimon", tag: "0.2.0-abcdef0"
  });
  assert.equal(identity.registry, "127.0.0.1:5000");
  assert.equal(identity.image, "acme/daimon");
  assert.match(renderRuntimesYamlPin(identity), /image: 127\.0\.0\.1:5000\/acme\/daimon\n/u);
  const hub = createPublishedIdentity(inputs, {
    contractManifestSha256: `sha256:${digest("7")}`, digest: `sha256:${digest("8")}`, platforms: { amd64: platform, arm64: platform },
    repository: "docker.io/noopolis/spawnfile-runtime-daimon", tag: "0.2.0-abcdef0"
  });
  assert.match(renderRuntimesYamlPin(hub), /image: noopolis\/spawnfile-runtime-daimon\n/u);
});

test("tag guard treats only a registry not-found as absence", () => {
  const failing = (stderr: string) => () => { throw Object.assign(new Error("Command failed"), { stderr }); };
  assert.equal(tagExists("r:t", () => undefined), true);
  assert.equal(tagExists("r:t", failing("ERROR: docker.io/noopolis/x:t: not found\n")), false);
  assert.throws(() => tagExists("r:t", failing("ERROR: failed to do request: dial tcp: i/o timeout\n")), /refusing to publish/u);
  assert.throws(() => tagExists("r:t", failing("ERROR: unauthorized: authentication required\n")), /refusing to publish/u);
});
