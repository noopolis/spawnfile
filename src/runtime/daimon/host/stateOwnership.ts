import path from "node:path";

import { SpawnfileError } from "../../../shared/errors.js";
import type { RuntimeHostBuildInput } from "../../hostTypes.js";
import { DAIMON_RUNTIME_UID, resolveDaimonUidEntrypointStateRoots } from "./uidEntrypointRender.js";

const SPAWNFILE_STATE_ROOT = "/var/lib/spawnfile";
const MOLTNET_STATE_ROOT = `${SPAWNFILE_STATE_ROOT}/moltnet`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const privateDirectoriesThrough = (target: string): string[] => {
  const relative = path.posix.relative(SPAWNFILE_STATE_ROOT, target);
  if (relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new SpawnfileError(
      "compile_error",
      `Generated Moltnet state path escapes ${SPAWNFILE_STATE_ROOT}: ${target}`
    );
  }
  const segments = relative === "" ? [] : relative.split("/");
  return [
    SPAWNFILE_STATE_ROOT,
    ...segments.map((_, index) =>
      path.posix.join(SPAWNFILE_STATE_ROOT, ...segments.slice(0, index + 1))
    )
  ];
};

const createMoltnetPrivacyCommands = (
  persistentMountPaths: string[],
  moltnet: RuntimeHostBuildInput["moltnet"]
): string[] => {
  if (!moltnet) return [];

  const configPaths = [
    ...moltnet.serverPlans.flatMap((plan) =>
      plan.mode === "managed" && plan.configPath ? [plan.configPath] : []
    ),
    ...moltnet.nodePlans.map((plan) => plan.configPath)
  ].sort();
  const receiptDirectories = moltnet.nodePlans.flatMap((plan) =>
    plan.receiptStorePath ? [path.posix.dirname(plan.receiptStorePath)] : []
  );
  if (configPaths.length === 0) return [];
  if (configPaths.some((configPath) => !configPath.startsWith(`${MOLTNET_STATE_ROOT}/`))) {
    throw new SpawnfileError(
      "compile_error",
      "Generated Moltnet config paths must stay beneath the private Moltnet state root"
    );
  }

  const moltnetMountPaths = persistentMountPaths
    .filter((mountPath) => mountPath.startsWith(`${MOLTNET_STATE_ROOT}/`));
  const privateDirectories = [
    ...new Set([
      ...configPaths.flatMap((configPath) =>
        privateDirectoriesThrough(path.posix.dirname(configPath))
      ),
      ...receiptDirectories.flatMap(privateDirectoriesThrough),
      ...moltnetMountPaths.flatMap(privateDirectoriesThrough)
    ])
  ].filter((directory) => directory !== SPAWNFILE_STATE_ROOT).sort();
  const ownership = `${DAIMON_RUNTIME_UID}:${DAIMON_RUNTIME_UID}`;

  return [
    `install -d -o ${DAIMON_RUNTIME_UID} -g ${DAIMON_RUNTIME_UID} -m 700 ${privateDirectories.map(shellQuote).join(" ")}`,
    `chown root:root ${configPaths.map(shellQuote).join(" ")}`,
    `chmod 600 ${configPaths.map(shellQuote).join(" ")}`,
    `chown ${ownership} ${configPaths.map(shellQuote).join(" ")}`
  ];
};

export const renderDaimonStateOwnership = ({
  runtimePlans, persistentMountPaths, moltnet
}: RuntimeHostBuildInput): string[] => [
  `chown root:root ${shellQuote(SPAWNFILE_STATE_ROOT)} && chmod 711 ${shellQuote(SPAWNFILE_STATE_ROOT)}`,
  ...resolveDaimonUidEntrypointStateRoots(runtimePlans).map((stateRoot) =>
    `install -d -o root -g root -m 700 ${shellQuote(stateRoot)}`),
  ...createMoltnetPrivacyCommands(persistentMountPaths, moltnet)
];
