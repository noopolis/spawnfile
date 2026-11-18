import { SpawnfileError } from "../shared/index.js";

import type { MoltnetNodePlan } from "./moltnetArtifactTypes.js";
import type { MoltnetReleaseIdentity } from "./moltnetBinaries.js";

export const assertMoltnetBridgeCapabilities = (
  nodePlans: readonly MoltnetNodePlan[],
  release: MoltnetReleaseIdentity | undefined
): void => {
  const capabilities: readonly string[] = release?.capabilities ?? [];
  const missing = new Map<string, Set<string>>();
  for (const { releaseCapability, networkId } of nodePlans) {
    if (!releaseCapability || capabilities.includes(releaseCapability)) continue;
    const networks = missing.get(releaseCapability) ?? new Set<string>();
    networks.add(networkId);
    missing.set(releaseCapability, networks);
  }
  if (!missing.size) return;
  const requirements = [...missing]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capability, networks]) => `${capability} capability (${[...networks].sort().join(", ")})`)
    .join(", ");
  const version = release && "release_version" in release ? release.release_version : release?.version ?? "(unstaged)";
  throw new SpawnfileError(
    "compile_error",
    `Moltnet release ${version} does not advertise the required ${requirements}. `
      + "The container would exit at boot. Stage a compatible release, verify a local build with scripts/build-local-moltnet.ts "
      + "and SPAWNFILE_LOCAL_MOLTNET_RELEASE_DIR with SPAWNFILE_ALLOW_LOCAL_E2E=1, or remove the affected attachments."
  );
};
