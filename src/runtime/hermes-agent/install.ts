import { SpawnfileError } from "../../shared/index.js";
import { standardRuntimeInstall } from "../adapterBase.js";
import type { RuntimeInstallCapability } from "../containerRecipe.js";

export const hermesImage = "docker.io/nousresearch/hermes-agent";
export const hermesTag = "v0.23.3";
export const hermesCommit = "caafe5389ae585ef77387a962aee05b1bcf17029";
export const hermesDigest = "sha256:3e9fe4c6ef36490f43aa0d0d80f9df64e9c92a576eee3042f1a97c8813c05355";
export const hermesImageRef = `${hermesImage}@${hermesDigest}`;
export const hermesBinary = "/opt/hermes/.venv/bin/hermes";

export const hermesInstall: RuntimeInstallCapability = {
  hints: {
    ...standardRuntimeInstall.hints,
    container_image: { ecosystem: "node", installHint: "Use the verified multi-platform Hermes Agent image." }
  },
  createRecipe({ containerEnv, runtimeName, selection }) {
    if (selection.kind !== "container_image" || selection.runtimeRef !== hermesTag ||
        selection.image !== hermesImage || selection.tag !== hermesTag || selection.digest !== hermesDigest) {
      throw new SpawnfileError("runtime_error", `Hermes Agent requires the verified ${hermesTag} image ${hermesImageRef}`);
    }

    return {
      requiredBaseImage: hermesImageRef,
      commands: [
        `ln -sf ${hermesBinary} /usr/local/bin/hermes`,
        `/opt/hermes/.venv/bin/python -c 'import json; p=json.load(open("/etc/hermes/image-provenance.json")); assert p["revision"] == "${hermesCommit}"'`
      ],
      copyCommands: [],
      env: containerEnv,
      runtimeName,
      runtimeRoot: "/opt/hermes"
    };
  }
};
