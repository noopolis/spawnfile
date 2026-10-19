#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { tagExists } from "./publish-daimon-runtime.ts";
import { readTrainingNativeInputs, renderTrainingNativeDockerfile, trainingNativeTag } from "./training-native-image.ts";

const repository = "noopolis/spawnfile-training-native";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Run = (args: string[]) => string;
const runDocker: Run = args => execFileSync("docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]
});

/** No force/latest path: a published release tag is immutable. CI serializes all refs. */
export const assertTrainingNativeTagAbsent = (reference: string, exists = tagExists): void => {
  if (exists(reference)) throw new Error(`${reference} already exists; refusing to move a published tag`);
};

export const publishTrainingNative = (options: { push: boolean; identityOut?: string }, run: Run = runDocker): void => {
  const inputs = readTrainingNativeInputs(root);
  const rendered = renderTrainingNativeDockerfile(
    readFileSync(path.join(root, "runtime-images/training-native/Dockerfile"), "utf8"), inputs);
  const tag = trainingNativeTag(inputs, rendered);
  const reference = `${repository}:${tag}`;
  const identity = (digest: string) => JSON.stringify({
    image_reference: `${repository}@${digest}`, tag, daimon: inputs.daimon, moltnet: inputs.moltnet
  }, null, 2);
  if (options.push && tagExists(reference)) {
    // Same tag means the same rendered recipe: report the published identity instead of rebuilding.
    const raw = run(["buildx", "imagetools", "inspect", "--raw", reference]);
    const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    if (options.identityOut) writeFileSync(options.identityOut, `${identity(digest)}\n`);
    process.stdout.write(`${reference} is already published as ${repository}@${digest}\n`);
    return;
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-training-native-"));
  try {
    const dockerfile = path.join(directory, "Dockerfile");
    const metadata = path.join(directory, "metadata.json");
    writeFileSync(dockerfile, rendered);
    // Push by digest first; the immutable tag is attached only after the build succeeds.
    const output = options.push
      ? `type=image,name=${repository},push-by-digest=true,name-canonical=true,push=true`
      : "type=cacheonly";
    process.stdout.write(run(["buildx", "build", "--platform", "linux/amd64,linux/arm64",
      "--provenance=false", "--sbom=false", "-f", dockerfile,
      "--metadata-file", metadata, "--output", output, directory]));
    if (!options.push) {
      process.stdout.write(`Dry-run built linux/amd64,linux/arm64 for ${reference}; nothing was pushed\n`);
      return;
    }
    const result = JSON.parse(readFileSync(metadata, "utf8")) as Record<string, unknown>;
    const digest = result["containerimage.digest"];
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
      throw new Error("Build did not report an immutable training-native digest");
    }
    const raw = run(["buildx", "imagetools", "inspect", "--raw", `${repository}@${digest}`]);
    const index = JSON.parse(raw) as { manifests?: { platform?: { os?: string; architecture?: string } }[] };
    if (`sha256:${createHash("sha256").update(raw).digest("hex")}` !== digest ||
        index.manifests?.length !== 2 ||
        !["amd64", "arm64"].every(arch => index.manifests?.some(
          entry => entry.platform?.os === "linux" && entry.platform.architecture === arch))) {
      throw new Error("Published digest does not identify the expected multi-architecture index");
    }
    assertTrainingNativeTagAbsent(reference);
    run(["buildx", "imagetools", "create", "--prefer-index=false", "-t", reference, `${repository}@${digest}`]);
    const tagged = run(["buildx", "imagetools", "inspect", "--raw", reference]);
    if (tagged !== raw) throw new Error("Published tag does not identify the built index");
    if (options.identityOut) writeFileSync(options.identityOut, `${identity(digest)}\n`);
    process.stdout.write(`Published ${reference} as ${repository}@${digest}\n${identity(digest)}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { push: { type: "boolean", default: false }, "identity-out": { type: "string" } } });
  publishTrainingNative({ push: values.push, identityOut: values["identity-out"] });
}
