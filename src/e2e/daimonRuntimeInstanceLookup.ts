import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import { toRootfsPath } from "./runtimeRootfsPaths.js";

/** Legacy generated-Pi E2Es are intentionally distinct from the public
 * Daimon organization host and therefore accept only Pi instances. */
const DAIMON_RUNTIME_LABELS = ["pi"] as const;

/**
 * Find the legacy generated-Pi runtime instance in a compiled container
 * report. Shared by generated-Pi E2E harnesses only.
 */
export const findDaimonRuntimeInstance = (
  runtimeInstances: readonly ContainerRuntimeInstanceReport[] | undefined
): ContainerRuntimeInstanceReport | undefined =>
  runtimeInstances?.find((candidate) =>
    (DAIMON_RUNTIME_LABELS as readonly string[]).includes(candidate.runtime)
  );

/**
 * Resolve the generated-Pi runtime install directory under a compiled
 * container's rootfs. Public Daimon organization hosts are never accepted by
 * this legacy app harness.
 */
export const resolveDaimonRuntimeRoot = async (rootfs: string): Promise<string> => {
  return toRootfsPath(rootfs, "/opt/spawnfile/runtime-installs/pi");
};
