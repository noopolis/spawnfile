import { fileURLToPath } from "node:url";

import {
  DAIMON_CONTRACT_MANIFEST_SHA256, daimonSupportsWakeMoments,
  readVerifiedDaimonContractManifest, type DaimonContractManifest
} from "../runtime/daimon/contractManifest.js";
import { SpawnfileError } from "../shared/index.js";
import type { CompilePlan } from "./types.js";

/** No runtime lookup, check output, or manifest I/O when recording is absent. */
export const assertRecordingCapability = async (
  plan: CompilePlan, injectedManifest?: DaimonContractManifest
): Promise<void> => {
  const agents = plan.nodes.filter((node) => node.kind === "agent" && node.value.training?.record !== undefined);
  if (agents.length === 0) return;
  for (const agent of agents) {
    if (agent.runtimeName !== "daimon") throw new SpawnfileError("validation_error",
      `Training recording for ${agent.id} requires Daimon; runtime ${agent.runtimeName ?? "unknown"} does not support wake moments`);
  }
  let manifest = injectedManifest;
  if (manifest === undefined) {
    const verified = await readVerifiedDaimonContractManifest(fileURLToPath(new URL("../runtime/daimon/", import.meta.url)));
    if (verified.digest !== DAIMON_CONTRACT_MANIFEST_SHA256) throw new SpawnfileError("validation_error",
      "Pinned Daimon contract manifest does not match the capability-receipt digest");
    manifest = verified.manifest;
  }
  if (!daimonSupportsWakeMoments(manifest)) throw new SpawnfileError("validation_error",
    "The pinned Daimon runtime image does not declare the wakeMoments capability; a Daimon release with it and a runtimes.yaml / contract-manifest re-pin are required");
};
