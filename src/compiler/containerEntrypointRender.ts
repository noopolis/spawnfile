import path from "node:path";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import { createMoltnetCausalEventsPath, resolveMoltnetStorePath } from "./moltnetConfigLowering.js";
import { networkUrlEnvName } from "./networkBinding.js";
import {
  createWorkspaceResourceCommands,
  createWorkspaceResourceShellFunctions
} from "./containerWorkspaceResourceRender.js";
import {
  createConfigEnvMaterializationFunction,
  createConfigEnvWrites
} from "./containerConfigEnvRender.js";
import {
  CLI_CREDENTIAL_SECRET_NAME,
  modelAuthMethodNeedsCliCredential
} from "./modelEnv.js";
import {
  createCliCredentialMaterialization,
  createRecipeEnvAssignments,
  mergeRecipeEnv,
  shellQuote
} from "./containerEntrypointShell.js";

const MOLTNET_SERVER_DATA_DIRECTORY = "/var/lib/spawnfile/moltnet/servers";

// moltnet reads this path from MOLTNET_CAUSAL_EVENTS_PATH
// (internal/app/config_load.go's mergeEnvConfig) and, when set, stamps
// every message.accepted/message.denied causal event there via
// internal/observability/causal.go's CausalWriter (nil/no-op otherwise).
// Always set, independent of the network's own store.kind (a memory-store
// network — e.g. office-sim's fixture — still gets a causal log). Points
// into a dedicated `causal/` subdirectory of the server's data directory
// (see createMoltnetCausalDirectory/createMoltnetCausalEventsPath) that
// moltnetArtifacts.ts registers as its own persistent mount, so it survives
// container teardown/restart via a host-backed named docker volume instead
// of only being recoverable through a live-container `docker cp` (the
// previous e2e-capture-only precedent).
const moltnetCausalEventsPath = createMoltnetCausalEventsPath;

const createEnvironmentAssignments = (plan: RuntimeTargetPlan): string[] => {
  const envAssignments: string[] = [];

  if (plan.instancePaths.homePath) {
    envAssignments.push(`HOME=${shellQuote(plan.instancePaths.homePath)}`);
  }

  if (
    plan.instancePaths.homePath &&
    Object.values(plan.modelAuthMethods).some(modelAuthMethodNeedsCliCredential)
  ) {
    envAssignments.push(`CODEX_HOME=${shellQuote(path.posix.join(plan.instancePaths.homePath, ".codex"))}`);
  }

  if (plan.meta.homeEnv && plan.instancePaths.homePath) {
    envAssignments.push(`${plan.meta.homeEnv}=${shellQuote(plan.instancePaths.homePath)}`);
  }

  if (plan.meta.configPathEnv) {
    envAssignments.push(`${plan.meta.configPathEnv}=${shellQuote(plan.instancePaths.configPath)}`);
  }

  if (plan.meta.portEnv && plan.port) {
    envAssignments.push(`${plan.meta.portEnv}=${shellQuote(String(plan.port))}`);
  }

  for (const [name, value] of Object.entries(plan.meta.staticEnv ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    envAssignments.push(`${name}=${shellQuote(value)}`);
  }

  envAssignments.push(...createRecipeEnvAssignments(plan.recipeEnv));

  return envAssignments;
};

const createEnvFileWrites = (plan: RuntimeTargetPlan): string[] =>
  plan.envFiles.map(
    (binding) => `write_env_file ${shellQuote(binding.envName)} ${shellQuote(binding.filePath)}`
  );

const createMoltnetStorePrepareCommands = (
  serverPlan: MoltnetArtifacts["serverPlans"][number]
): string[] => {
  const server = serverPlan.server;
  if (server.mode !== "managed" || server.store.kind === "memory" || server.store.kind === "postgres") {
    return [];
  }

  const storePath = resolveMoltnetStorePath(serverPlan.networkId, server.store);
  if (!storePath) {
    return [];
  }

  return [`mkdir -p ${shellQuote(path.posix.dirname(storePath))}`];
};

const resolveStartCommand = (plan: RuntimeTargetPlan): string[] =>
  plan.meta.startCommand
    .map((token) =>
      token
        .replaceAll("<config-path>", plan.instancePaths.configPath)
        .replaceAll("<home-path>", plan.instancePaths.homePath ?? "")
        .replaceAll("<runtime-root>", plan.runtimeRoot)
        .replaceAll("<workspace-path>", plan.instancePaths.workspacePath)
        .replaceAll("<port>", plan.port ? String(plan.port) : "")
    )
    .filter((token) => token.length > 0);

const createRuntimeReadinessWait = (plan: RuntimeTargetPlan): string[] => {
  if (!["openclaw", "pi"].includes(plan.runtimeName) || !plan.port) {
    return [];
  }

  return [
    "attempts=0",
    `until curl -sf ${shellQuote(`http://127.0.0.1:${plan.port}/healthz`)} >/dev/null; do`,
    "  attempts=$((attempts + 1))",
    '  if [ "$attempts" -ge 180 ]; then',
    `    echo ${shellQuote(`Timed out waiting for ${plan.runtimeName} on port ${plan.port}`)} >&2`,
    "    exit 1",
    "  fi",
    "  sleep 1",
    "done",
    ""
  ];
};

export interface EntrypointOptions {
  hasMoltnet?: boolean;
  hasStagedMoltnetBinaries?: boolean;
  moltnet?: {
    externalParticipantArtifacts?: NonNullable<MoltnetArtifacts["externalParticipantArtifacts"]>;
    nodePlans: MoltnetArtifacts["nodePlans"];
    serverPlans: MoltnetArtifacts["serverPlans"];
  };
  moltnetPublishedPorts?: number[];
  persistentMountPaths?: string[];
}

export const renderEntrypoint = (
  runtimePlans: RuntimeTargetPlan[],
  requiredSecrets: string[],
  options: EntrypointOptions = {}
): string => {
  const cliCredentialMaterialization = createCliCredentialMaterialization(runtimePlans);
  const renderedRequiredSecrets = [
    ...new Set([
      ...requiredSecrets,
      ...(cliCredentialMaterialization.length > 0 ? [CLI_CREDENTIAL_SECRET_NAME] : [])
    ])
  ];
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "require_env() {",
    '  local name=\"$1\"',
    '  if [ -z \"${!name:-}\" ]; then',
    '    echo \"Missing required env: $name\" >&2',
    "    exit 1",
    "  fi",
    "}",
    "",
    "require_file() {",
    '  local target=\"$1\"',
    '  if [ ! -f \"$target\" ]; then',
    '    echo \"Missing required file: $target\" >&2',
    "    exit 1",
    "  fi",
    "}",
    "",
    "write_env_file() {",
    '  local name=\"$1\"',
    '  local target=\"$2\"',
    '  if [ -z \"${!name:-}\" ]; then',
    "    return",
    "  fi",
    '  mkdir -p \"$(dirname \"$target\")\"',
    '  printf %s \"${!name:-}\" > \"$target\"',
    "}",
    "",
    ...createConfigEnvMaterializationFunction(),
    "",
    ...createWorkspaceResourceShellFunctions()
  ];

  lines.push(
    'if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ] && [ -z "${OPENCLAW_HOOKS_TOKEN:-}" ]; then',
    '  export OPENCLAW_HOOKS_TOKEN="hooks-${OPENCLAW_GATEWAY_TOKEN}"',
    "fi",
    ""
  );

  for (const secretName of renderedRequiredSecrets) {
    lines.push(`require_env ${shellQuote(secretName)}`);
  }

  if (renderedRequiredSecrets.length > 0) {
    lines.push("");
  }

  lines.push(...cliCredentialMaterialization);

  const moltnetServerPlans = options.moltnet?.serverPlans ?? [];
  const moltnetNodePlans = options.moltnet?.nodePlans ?? [];
  const moltnetExternalParticipants = options.moltnet?.externalParticipantArtifacts ?? [];

  if (
    runtimePlans.length === 1 &&
    moltnetServerPlans.length === 0 &&
    moltnetNodePlans.length === 0
  ) {
    const plan = runtimePlans[0]!;
    const commandTokens = resolveStartCommand(plan);
    const envAssignments = createEnvironmentAssignments(plan);

    lines.push(
      `mkdir -p ${shellQuote(plan.instancePaths.workspacePath)}`,
      ...createWorkspaceResourceCommands(plan),
      `require_file ${shellQuote(plan.instancePaths.configPath)}`,
      ...createEnvFileWrites(plan),
      ...createConfigEnvWrites(plan),
      `${envAssignments.join(" ")} exec ${commandTokens.map(shellQuote).join(" ")}`
    );

    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push(
    "PIDS=()",
    "",
    "terminate_children() {",
    '  for pid in "${PIDS[@]:-}"; do',
    '    kill "$pid" 2>/dev/null || true',
    "  done",
    "}",
    "",
    "trap terminate_children INT TERM EXIT",
    ""
  );

  const recipeEnvAssignments = createRecipeEnvAssignments(mergeRecipeEnv(runtimePlans));
  const recipeEnvPrefix =
    recipeEnvAssignments.length > 0 ? `${recipeEnvAssignments.join(" ")} ` : "";

  const managedMoltnetServerPlans = moltnetServerPlans.filter((serverPlan) => serverPlan.mode === "managed");

  if (managedMoltnetServerPlans.length > 0) {
    lines.push(`mkdir -p ${shellQuote(MOLTNET_SERVER_DATA_DIRECTORY)}`, "");
  }

  for (const serverPlan of managedMoltnetServerPlans) {
    if (!serverPlan.configPath) {
      continue;
    }
    const urlEnv = networkUrlEnvName(serverPlan.networkId);
    const serverLines: string[] = [];
    for (const patch of serverPlan.secretPatches) {
      serverLines.push(
        `apply_json_env_value ${shellQuote(serverPlan.configPath)} ${shellQuote(patch.envName)} ${shellQuote(patch.jsonPath)}`
      );
    }
    const causalEventsPath = moltnetCausalEventsPath(serverPlan.configPath);
    serverLines.push(
      ...createMoltnetStorePrepareCommands(serverPlan),
      `MOLTNET_CONFIG=${shellQuote(serverPlan.configPath)} MOLTNET_CAUSAL_EVENTS_PATH=${shellQuote(causalEventsPath)} ${recipeEnvPrefix}/usr/local/bin/moltnet &`,
      'PIDS+=("$!")'
    );
    if (serverPlan.port) {
      serverLines.push(
        `until curl -sf ${shellQuote(`http://127.0.0.1:${serverPlan.port}/healthz`)} >/dev/null; do sleep 1; done`
      );
    }
    const externalParticipants = moltnetExternalParticipants.filter(
      (artifact) => artifact.network.id === serverPlan.networkId
    );
    if (externalParticipants.length > 0) {
      const clientTokenId = serverPlan.server.auth.client?.token_id;
      const clientToken = serverPlan.server.auth.tokens?.find(
        (token) => token.id === clientTokenId
      );
      if (!serverPlan.port || !clientToken?.secret) {
        throw new Error(
          `Managed Moltnet external participant topology for ${serverPlan.networkId} requires an operator token and port`
        );
      }
      for (const artifact of externalParticipants) {
        for (const directMessage of artifact.direct_messages) {
          serverLines.push(
            [
              "/usr/local/bin/moltnet admin dm ensure",
              `--sender ${shellQuote(artifact.participant.member_id)}`,
              ...directMessage.members.map((member) => `--member ${shellQuote(member)}`),
              `--base-url ${shellQuote(`http://127.0.0.1:${serverPlan.port}`)}`,
              `--token-env ${shellQuote(clientToken.secret)}`,
              ">/dev/null"
            ].join(" ")
          );
        }
      }
    }
    // Suppress the in-image managed server when an external endpoint is bound.
    lines.push(
      `if [ -z "\${${urlEnv}:-}" ]; then`,
      ...serverLines.map((line) => `  ${line}`),
      "fi",
      ""
    );
  }

  for (const plan of runtimePlans) {
    const commandTokens = resolveStartCommand(plan);
    const envAssignments = createEnvironmentAssignments(plan);

    lines.push(
      `mkdir -p ${shellQuote(plan.instancePaths.workspacePath)}`,
      ...createWorkspaceResourceCommands(plan),
      `require_file ${shellQuote(plan.instancePaths.configPath)}`,
      ...createEnvFileWrites(plan),
      ...createConfigEnvWrites(plan),
      `${envAssignments.join(" ")} ${commandTokens.map(shellQuote).join(" ")} &`,
      'PIDS+=("$!")',
      "",
      ...createRuntimeReadinessWait(plan)
    );
  }

  for (const nodePlan of moltnetNodePlans) {
    const urlEnv = networkUrlEnvName(nodePlan.networkId);
    lines.push(
      // Rebind the bridge endpoint when an external network URL is provided.
      `if [ -n "\${${urlEnv}:-}" ]; then`,
      `  apply_json_env_value ${shellQuote(nodePlan.configPath)} ${shellQuote(urlEnv)} ${shellQuote("moltnet.base_url")}`,
      "fi",
      `${recipeEnvPrefix}/usr/local/bin/moltnet node ${shellQuote(nodePlan.configPath)} &`,
      'PIDS+=("$!")',
      ""
    );
  }

  lines.push(
    'if [ "${#PIDS[@]}" -eq 0 ]; then',
    '  echo "No runtime targets were generated for this compile output" >&2',
    "  exit 1",
    "fi",
    "",
    "status=0",
    'for pid in "${PIDS[@]}"; do',
    '  if ! wait "$pid"; then',
    "    status=1",
    "  fi",
    "done",
    "",
    'exit "$status"'
  );

  return `${lines.join("\n").trimEnd()}\n`;
};
