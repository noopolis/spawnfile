import path from "node:path";

import { selectRuntimeEntrypoint } from "../runtime/hostSelection.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { EntrypointOptions } from "./containerEntrypointRender.js";
import { MOLTNET_READINESS_DIRECTORY } from "./containerReadinessPaths.js";
import { VOLUME_BOOTSTRAP_MARKER,VOLUME_BOOTSTRAP_MARKER_CONTENT } from "./containerVolumeBootstrap.js";
export { VOLUME_BOOTSTRAP_MARKER,VOLUME_BOOTSTRAP_MARKER_CONTENT } from "./containerVolumeBootstrap.js";

const SPAWNFILE_STATE_ROOT = "/var/lib/spawnfile";
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

export const createStateOwnershipCommand = (
  runtimePlans: RuntimeTargetPlan[],
  persistentMountPaths: string[] = [],
  moltnet?: EntrypointOptions["moltnet"]
): string => {
  const mountPaths = [...new Set(persistentMountPaths)].sort();
  const wrapper = selectRuntimeEntrypoint(runtimePlans.map((plan) => plan.runtimeName));
  const mkdirPaths = [...new Set([SPAWNFILE_STATE_ROOT, ...mountPaths])].sort();
  const markerCommands = mountPaths.map((mountPath) =>
    `printf '%s\\n' ${shellQuote(VOLUME_BOOTSTRAP_MARKER_CONTENT)} > ${shellQuote(path.posix.join(mountPath, VOLUME_BOOTSTRAP_MARKER))} && chmod 600 ${shellQuote(path.posix.join(mountPath, VOLUME_BOOTSTRAP_MARKER))}`
  );
  const chownPaths = [
    ...new Set([
      ...(wrapper ? [] : [SPAWNFILE_STATE_ROOT]),
      ...mountPaths.filter((mountPath) => !mountPath.startsWith(`${SPAWNFILE_STATE_ROOT}/`))
    ])
  ].sort();

  return [
    `mkdir -p ${mkdirPaths.map(shellQuote).join(" ")}`,
    ...markerCommands,
    ...(!wrapper && moltnet?.nodePlans.length
      ? [`install -d -o spawnfile -g spawnfile -m 700 ${shellQuote(MOLTNET_READINESS_DIRECTORY)}`]
      : []),
    ...(chownPaths.length > 0
      ? [`chown -R spawnfile:spawnfile ${chownPaths.map(shellQuote).join(" ")}`]
      : []),
    ...(wrapper?.entrypoint.stateOwnership?.({
      runtimePlans,
      persistentMountPaths: mountPaths,
      persistentMounts: [],
      moltnet
    }) ?? [])
  ].join(" && ");
};
