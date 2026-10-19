import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { createDaimonInstallCommands } from "../src/runtime/daimonInstall.ts";
import { assertTrainingNativeTagAbsent } from "./publish-training-native.ts";
import { parseTrainingNativeInputs, readTrainingNativeInputs, renderTrainingNativeDockerfile } from "./training-native-image.ts";

const registry = () => parseYaml(readFileSync("runtimes.yaml", "utf8"));
const release = () => JSON.parse(readFileSync("moltnet-releases.json", "utf8"));
const template = readFileSync("runtime-images/training-native/Dockerfile", "utf8");

test("reads checked-in authority pins and derives the release tag", () => {
  const inputs = readTrainingNativeInputs(".");
  assert.deepEqual(inputs.daimon, registry().runtimes.daimon.install);
  assert.deepEqual(inputs.moltnet, release());
  assert.equal(inputs.tag, `${inputs.daimon.tag}-moltnet-${inputs.moltnet.release_version}`);
});

test("renders immutable sources, shared receipt/manifest/broker checks, and verified arch assets", () => {
  const inputs = readTrainingNativeInputs(".");
  const rendered = renderTrainingNativeDockerfile(template, inputs);
  assert.ok(rendered.includes(`FROM ${inputs.daimon.image}@${inputs.daimon.digest} AS daimon`));
  assert.match(rendered, /FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.doesNotMatch(rendered, /trusted=yes|AllowUnauthenticated/u);
  for (const command of createDaimonInstallCommands("/opt/spawnfile/runtime-installs/daimon", inputs.daimon.capability_receipts)) {
    assert.ok(rendered.includes(command));
  }
  // Independent assertion: deleting receipt verification from the shared helper must fail.
  assert.match(rendered, /sha256sum \/opt\/spawnfile\/runtime-installs\/daimon\/capability-receipt.json/u);
  for (const arch of ["amd64", "arm64"] as const) {
    assert.ok(rendered.includes(inputs.daimon.capability_receipts[arch]));
    const asset = inputs.moltnet.assets.find(item => item.architecture === arch)!;
    assert.ok(rendered.includes(`https://github.com/noopolis/moltnet/releases/download/${inputs.moltnet.release_version}/${asset.asset}`));
    assert.ok(rendered.includes(asset.asset_sha256.slice(7)));
  }
  assert.ok(rendered.indexOf("sha256sum -c -") < rendered.indexOf("tar -xzf"));
  assert.match(rendered, /install -m 0755 .* \/usr\/local\/bin\/moltnet/u);
  assert.match(rendered, /ln -s .*\/node_modules \/opt\/paideia\/node_modules/u);
  assert.doesNotMatch(rendered, /@@|evaluator-codex|npm install|mneme\/package.json/u);
});

test("refuses missing, malformed or contract-mismatched Daimon pins and incomplete Moltnet assets", () => {
  for (const key of ["digest", "tag", "capability_receipts", "contract_manifest_sha256"]) {
    const value = registry(); delete value.runtimes.daimon.install[key];
    assert.throws(() => parseTrainingNativeInputs(value, release()), key);
  }
  for (const key of ["digest", "contract_manifest_sha256"]) {
    const value = registry(); value.runtimes.daimon.install[key] = `sha256:${"0".repeat(64)}`;
    if (key === "digest") value.runtimes.daimon.install[key] = "mutable";
    assert.throws(() => parseTrainingNativeInputs(value, release()), key);
  }
  const value = registry(); delete value.runtimes.daimon.install.capability_receipts.arm64;
  assert.throws(() => parseTrainingNativeInputs(value, release()));
  const moltnet = release(); moltnet.assets.pop();
  assert.throws(() => parseTrainingNativeInputs(registry(), moltnet));
  const bad = release(); bad.assets[0].asset_sha256 = "missing";
  assert.throws(() => parseTrainingNativeInputs(registry(), bad));
});

test("refuses malformed recipe slots and revalidates inputs before rendering", () => {
  const inputs = readTrainingNativeInputs(".");
  assert.throws(() => renderTrainingNativeDockerfile("FROM scratch", inputs));
  inputs.daimon.contract_manifest_sha256 = `sha256:${"0".repeat(64)}` as typeof inputs.daimon.contract_manifest_sha256;
  assert.throws(() => renderTrainingNativeDockerfile(template, inputs));
});

test("refuses moving an existing tag; registry errors propagate", () => {
  assert.throws(() => assertTrainingNativeTagAbsent("example:tag", () => true), /refusing to move/u);
  assert.doesNotThrow(() => assertTrainingNativeTagAbsent("example:tag", () => false));
  assert.throws(() => assertTrainingNativeTagAbsent("example:tag", () => { throw new Error("registry unavailable"); }), /unavailable/u);
});
