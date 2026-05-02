import path from "node:path";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";

const MOLTNET_SERVER_DATA_DIRECTORY = "/var/lib/spawnfile/moltnet/servers";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const pathSafeSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "server";

const createMoltnetServerDataPath = (serverId: string): string =>
  `${MOLTNET_SERVER_DATA_DIRECTORY}/${pathSafeSegment(serverId)}.db`;

const createEnvironmentAssignments = (plan: RuntimeTargetPlan): string[] => {
  const envAssignments: string[] = [];

  if (plan.instancePaths.homePath) {
    envAssignments.push(`HOME=${shellQuote(plan.instancePaths.homePath)}`);
  }

  if (
    plan.runtimeName === "tinyclaw" &&
    plan.instancePaths.homePath &&
    (plan.modelAuthMethods.openai === "api_key" || plan.modelAuthMethods.openai === "codex")
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

  return envAssignments;
};

const createEnvFileWrites = (plan: RuntimeTargetPlan): string[] =>
  plan.envFiles.map(
    (binding) => `write_env_file ${shellQuote(binding.envName)} ${shellQuote(binding.filePath)}`
  );

const createConfigEnvWrites = (plan: RuntimeTargetPlan): string[] =>
  (plan.configEnvBindings ?? []).map(
    (binding) =>
      `apply_json_env_value ${shellQuote(plan.instancePaths.configPath)} ${shellQuote(binding.envName)} ${shellQuote(binding.jsonPath)}`
  );

const createAuthSetupCommands = (plan: RuntimeTargetPlan): string[] => {
  if (
    plan.runtimeName !== "tinyclaw" ||
    !plan.instancePaths.homePath ||
    plan.modelAuthMethods.openai !== "api_key"
  ) {
    return [];
  }

  return [`configure_codex_api_key_auth ${shellQuote(plan.instancePaths.homePath)}`];
};

const resolveStartCommand = (plan: RuntimeTargetPlan): string[] =>
  plan.meta.startCommand
    .map((token) =>
      token
        .replaceAll("<runtime-root>", plan.runtimeRoot)
        .replaceAll("<port>", plan.port ? String(plan.port) : "")
    )
    .filter((token) => token.length > 0);

const createRuntimeReadinessWait = (plan: RuntimeTargetPlan): string[] => {
  if (plan.runtimeName !== "openclaw" || !plan.port) {
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
    bridgePlans: MoltnetArtifacts["bridgePlans"];
    serverPlans: MoltnetArtifacts["serverPlans"];
  };
  moltnetPublishedPorts?: number[];
}

export const renderEntrypoint = (
  runtimePlans: RuntimeTargetPlan[],
  requiredSecrets: string[],
  options: EntrypointOptions = {}
): string => {
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
    "apply_json_env_value() {",
    '  local target=\"$1\"',
    '  local name=\"$2\"',
    '  local json_path=\"$3\"',
    '  if [ -z \"${!name:-}\" ]; then',
    "    return",
    "  fi",
    "  python3 - \"$target\" \"$name\" \"$json_path\" <<'PY'",
    "import json",
    "import os",
    "import sys",
    "",
    "target_path = sys.argv[1]",
    "env_name = sys.argv[2]",
    "json_path = sys.argv[3].split('.')",
    "value = os.environ.get(env_name)",
    "if value is None:",
    "    raise SystemExit(0)",
    "",
    "with open(target_path, encoding='utf-8') as handle:",
    "    data = json.load(handle)",
    "",
    "cursor = data",
    "for part in json_path[:-1]:",
    "    child = cursor.get(part)",
    "    if not isinstance(child, dict):",
    "        child = {}",
    "        cursor[part] = child",
    "    cursor = child",
    "",
    "cursor[json_path[-1]] = value",
    "",
    "with open(target_path, 'w', encoding='utf-8') as handle:",
    "    json.dump(data, handle, indent=2)",
    "    handle.write('\\n')",
    "PY",
    "}",
    "",
    "configure_codex_api_key_auth() {",
    '  local home_path="$1"',
    '  if [ -z "${OPENAI_API_KEY:-}" ]; then',
    "    return",
    "  fi",
    '  mkdir -p "$home_path/.codex"',
    '  printf "%s\\n" "${OPENAI_API_KEY:-}" | HOME="$home_path" CODEX_HOME="$home_path/.codex" codex login --with-api-key >/dev/null',
    "}",
    ""
  ];

  lines.push(
    'if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ] && [ -z "${OPENCLAW_HOOKS_TOKEN:-}" ]; then',
    '  export OPENCLAW_HOOKS_TOKEN="hooks-${OPENCLAW_GATEWAY_TOKEN}"',
    "fi",
    ""
  );

  for (const secretName of requiredSecrets) {
    lines.push(`require_env ${shellQuote(secretName)}`);
  }

  if (requiredSecrets.length > 0) {
    lines.push("");
  }

  const moltnetServerPlans = options.moltnet?.serverPlans ?? [];
  const moltnetBridgePlans = options.moltnet?.bridgePlans ?? [];

  if (
    runtimePlans.length === 1 &&
    moltnetServerPlans.length === 0 &&
    moltnetBridgePlans.length === 0
  ) {
    const plan = runtimePlans[0]!;
    const commandTokens = resolveStartCommand(plan);
    const envAssignments = createEnvironmentAssignments(plan);

    lines.push(
      `mkdir -p ${shellQuote(plan.instancePaths.workspacePath)}`,
      `require_file ${shellQuote(plan.instancePaths.configPath)}`,
      ...createEnvFileWrites(plan),
      ...createConfigEnvWrites(plan),
      ...createAuthSetupCommands(plan),
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

  if (moltnetServerPlans.length > 0) {
    lines.push(`mkdir -p ${shellQuote(MOLTNET_SERVER_DATA_DIRECTORY)}`, "");
  }

  for (const serverPlan of moltnetServerPlans) {
    lines.push(
      `MOLTNET_DATA_PATH=${shellQuote(createMoltnetServerDataPath(serverPlan.id))} MOLTNET_LISTEN_ADDR=${shellQuote(`:${serverPlan.port}`)} MOLTNET_NETWORK_ID=${shellQuote(serverPlan.networkId)} MOLTNET_NETWORK_NAME=${shellQuote(serverPlan.name)} /usr/local/bin/moltnet &`,
      'PIDS+=("$!")',
      ""
    );
  }

  for (const plan of runtimePlans) {
    const commandTokens = resolveStartCommand(plan);
    const envAssignments = createEnvironmentAssignments(plan);

    lines.push(
      `mkdir -p ${shellQuote(plan.instancePaths.workspacePath)}`,
      `require_file ${shellQuote(plan.instancePaths.configPath)}`,
      ...createEnvFileWrites(plan),
      ...createConfigEnvWrites(plan),
      ...createAuthSetupCommands(plan),
      `${envAssignments.join(" ")} ${commandTokens.map(shellQuote).join(" ")} &`,
      'PIDS+=("$!")',
      "",
      ...createRuntimeReadinessWait(plan)
    );
  }

  for (const serverPlan of moltnetServerPlans) {
    lines.push(
      `until curl -sf ${shellQuote(`http://127.0.0.1:${serverPlan.port}/healthz`)} >/dev/null; do sleep 1; done`
    );

    for (const room of serverPlan.rooms) {
      lines.push(
        `curl -sf -X POST -H 'Content-Type: application/json' -d ${shellQuote(
          JSON.stringify({
            id: room.id,
            members: room.members
          })
        )} ${shellQuote(`http://127.0.0.1:${serverPlan.port}/v1/rooms`)} >/dev/null || true`
      );
    }

    lines.push("");
  }

  for (const bridgePlan of moltnetBridgePlans) {
    lines.push(
      `/usr/local/bin/moltnet bridge ${shellQuote(bridgePlan.configPath)} &`,
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
