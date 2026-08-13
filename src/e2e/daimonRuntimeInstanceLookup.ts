import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import { fileExists } from "../filesystem/index.js";
import { toRootfsPath } from "./runtimeRootfsPaths.js";

/** Runtime labels a generated Pi/Daimon app's container-level instance may
 * report: some compiler report versions label it "pi" (the underlying
 * adapter), others "daimon" (the orchestrating runtime). */
const DAIMON_RUNTIME_LABELS = ["daimon", "pi"] as const;

/**
 * Find the generated Pi/Daimon runtime instance in a compiled container
 * report, tolerating both the current "daimon" runtime label and the legacy
 * "pi" label. Shared by every generated Pi/Daimon-app E2E harness.
 */
export const findDaimonRuntimeInstance = (
  runtimeInstances: readonly ContainerRuntimeInstanceReport[] | undefined
): ContainerRuntimeInstanceReport | undefined =>
  runtimeInstances?.find((candidate) =>
    (DAIMON_RUNTIME_LABELS as readonly string[]).includes(candidate.runtime)
  );

/**
 * Resolve the generated Pi/Daimon runtime install directory under a
 * compiled container's rootfs, tolerating both the current "daimon"
 * install-dir name and the legacy "pi" name. Shared by every generated
 * Pi/Daimon-app E2E harness.
 */
export const resolveDaimonRuntimeRoot = async (rootfs: string): Promise<string> => {
  const daimonRoot = toRootfsPath(rootfs, "/opt/spawnfile/runtime-installs/daimon");
  return (await fileExists(daimonRoot))
    ? daimonRoot
    : toRootfsPath(rootfs, "/opt/spawnfile/runtime-installs/pi");
};
