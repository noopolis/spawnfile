import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { readVerifiedDaimonContractManifest } from "../runtime/daimon/contractManifest.js";
import { SpawnfileError } from "../shared/errors.js";

import type { DockerCommandRunner } from "./dockerRunner.js";
import { extractSingleFileFromTar } from "./tarReader.js";

const RUNTIME_ROOT = "/opt/spawnfile/runtime-installs/daimon";

/** The selected image owns its historical contract, not the consumer's registry. */
export const readDaimonImageContract = async (
  helperName: string,
  runDocker: DockerCommandRunner,
  temporaryDirectory: string
) => {
  const directory = await mkdtemp(path.join(temporaryDirectory, "daimon-contract-"));
  try {
    const copy = async (name: string, maxBytes: number): Promise<Buffer> => {
      const tar = await runDocker(["cp", `${helperName}:${RUNTIME_ROOT}/${name}`, "-"]);
      return extractSingleFileFromTar(tar, { maxBytes });
    };
    const manifest = await copy("contract-manifest.json", 4 * 1024 * 1024);
    const sidecar = await copy("contract-manifest.sha256", 128);
    const receiptBytes = await copy("capability-receipt.json", 1024 * 1024);
    await writeFile(path.join(directory, "contract-manifest.json"), manifest);
    await writeFile(path.join(directory, "contract-manifest.sha256"), sidecar);
    const verified = await readVerifiedDaimonContractManifest(directory);
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown> | null;
    if (!receipt || Array.isArray(receipt)
      || receipt.version !== "spawnfile.daimon-runtime-capability-receipt.v1"
      || receipt.manifest_sha256 !== verified.digest) {
      throw new Error("capability receipt does not bind the image manifest");
    }
    return verified.manifest.engines;
  } catch (error) {
    throw new SpawnfileError("validation_error", "Could not verify Daimon's embedded image contract: "
      + (error instanceof Error ? error.message : String(error)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
