import path from "node:path";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
import { resolveMoltnetStorePath } from "./moltnetConfigLowering.js";
import { networkUrlEnvName } from "./networkBinding.js";
import {
  createWorkspaceResourceCommands,
  createWorkspaceResourceShellFunctions
} from "./containerWorkspaceResourceRender.js";

const MOLTNET_SERVER_DATA_DIRECTORY = "/var/lib/spawnfile/moltnet/servers";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const createEnvironmentAssignments = (plan: RuntimeTargetPlan): string[] => {
  const envAssignments: string[] = [];

  if (plan.instancePaths.homePath) {
    envAssignments.push(`HOME=${shellQuote(plan.instancePaths.homePath)}`);
  }

  if (
    plan.instancePaths.homePath &&
    plan.runtimeName === "picoclaw" &&
    plan.modelAuthMethods.openai === "codex"
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
    "    if isinstance(cursor, list):",
    "        cursor = cursor[int(part)]",
    "        continue",
    "    child = cursor.get(part)",
    "    if not isinstance(child, (dict, list)):",
    "        child = {}",
    "        cursor[part] = child",
    "    cursor = child",
    "",
    "if isinstance(cursor, list):",
    "    cursor[int(json_path[-1])] = value",
    "else:",
    "    cursor[json_path[-1]] = value",
    "",
    "with open(target_path, 'w', encoding='utf-8') as handle:",
    "    json.dump(data, handle, indent=2)",
    "    handle.write('\\n')",
    "PY",
    "}",
    "",
    ...createWorkspaceResourceShellFunctions()
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
  const moltnetNodePlans = options.moltnet?.nodePlans ?? [];

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
    serverLines.push(
      ...createMoltnetStorePrepareCommands(serverPlan),
      `MOLTNET_CONFIG=${shellQuote(serverPlan.configPath)} /usr/local/bin/moltnet &`,
      'PIDS+=("$!")'
    );
    if (serverPlan.port) {
      serverLines.push(
        `until curl -sf ${shellQuote(`http://127.0.0.1:${serverPlan.port}/healthz`)} >/dev/null; do sleep 1; done`
      );
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
      `/usr/local/bin/moltnet node ${shellQuote(nodePlan.configPath)} &`,
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
