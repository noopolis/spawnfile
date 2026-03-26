import type { ResolvedAgentNode, ResolvedTeamNode } from "../../compiler/types.js";
import { listEffectiveExecutionModelTargets } from "../../compiler/modelEnv.js";
import type {
  AdapterCompileResult,
  ContainerTarget,
  ContainerTargetInput,
  RuntimeAdapter
} from "../types.js";
import { SpawnfileError } from "../../shared/index.js";
import {
  createCapability,
  createAgentCapabilities,
  createDocumentFiles,
  createSkillFiles
} from "../common.js";
import { prepareTinyClawRuntimeAuth } from "./runAuth.js";
import { createTinyClawAgentScaffold } from "./scaffold.js";

const WORKSPACE_PLACEHOLDER = "<workspace-path>";
const TINYCLAW_START_SCRIPT = `
set -euo pipefail
PIDS=()
node <runtime-root>/packages/main/dist/index.js &
PIDS+=("$!")
sleep 1
while IFS= read -r channel; do
  case "$channel" in
    discord)
      node <runtime-root>/packages/channels/dist/discord.js &
      PIDS+=("$!")
      ;;
  esac
done < <(python3 - <<'PY'
import json
import os

settings_path = os.path.join(os.environ["TINYAGI_HOME"], "settings.json")
try:
    with open(settings_path, encoding="utf-8") as handle:
        settings = json.load(handle)
except FileNotFoundError:
    raise SystemExit(0)

for channel in settings.get("channels", {}).get("enabled", []):
    print(channel)
PY
)
terminate_children() {
  for pid in "\${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap terminate_children INT TERM EXIT
status=0
for pid in "\${PIDS[@]}"; do
  if ! wait "$pid"; then
    status=1
  fi
done
exit "$status"
`.trim();

const buildTinyClawSettings = (node: ResolvedAgentNode): string => {
  const [primary] = listEffectiveExecutionModelTargets(node.execution);
  const agentEntry: Record<string, unknown> = {
    name: node.name,
    provider: primary?.provider ?? "anthropic",
    model: primary?.name ?? "opus",
    working_directory: `${WORKSPACE_PLACEHOLDER}/${node.name}`
  };

  const enabledChannels = node.surfaces?.discord ? ["discord"] : [];

  const config: Record<string, unknown> = {
    workspace: {
      path: WORKSPACE_PLACEHOLDER,
      name: "workspace"
    },
    channels: {
      enabled: enabledChannels,
      ...(node.surfaces?.discord ? { discord: {} } : {})
    },
    agents: {
      [node.name]: agentEntry
    },
    models: {
      provider: primary?.provider ?? "anthropic"
    },
    monitoring: {
      heartbeat_interval: 3600
    }
  };

  return `${JSON.stringify(config, null, 2)}\n`;
};

const parseJsonFile = (
  input: ContainerTargetInput,
  filePath: string
): Record<string, unknown> => {
  const file = input.emittedFiles.find((entry) => entry.path === filePath);
  if (!file) {
    throw new Error(`TinyClaw target ${input.id} is missing ${filePath}`);
  }

  return JSON.parse(file.content) as Record<string, unknown>;
};

const resolveDiscordTokenBinding = (
  inputs: ContainerTargetInput[]
): ContainerTarget["configEnvBindings"] => {
  const envNames = [
    ...new Set(
      inputs.flatMap((input) => {
        if (input.kind !== "agent" || input.value.kind !== "agent") {
          return [];
        }

        return input.value.surfaces?.discord
          ? [input.value.surfaces.discord.botTokenSecret]
          : [];
      })
    )
  ];

  if (envNames.length === 0) {
    return undefined;
  }

  if (envNames.length > 1) {
    throw new SpawnfileError(
      "validation_error",
      `TinyClaw runtime target declares conflicting Discord bot token secrets: ${envNames.join(", ")}`
    );
  }

  return [
    {
      envName: envNames[0],
      jsonPath: "channels.discord.bot_token"
    }
  ];
};

const mergeTinyClawTargets = async (
  inputs: ContainerTargetInput[]
): Promise<ContainerTarget[]> => {
  const agentInputs = inputs.filter((input) => input.kind === "agent");
  if (agentInputs.length === 0) {
    return [];
  }

  const mergedAgents: Record<string, unknown> = {};
  const mergedTeams: Record<string, unknown> = {};
  const enabledChannels = new Set<string>();
  let hasDiscordChannel = false;
  const workspaceFiles = agentInputs.flatMap((input) =>
    input.emittedFiles.filter((file) => file.path !== "settings.json")
  );

  let mergedBase: Record<string, unknown> | null = null;

  for (const input of agentInputs) {
    const settings = parseJsonFile(input, "settings.json");
    const channels = (settings.channels as Record<string, unknown> | undefined) ?? {};
    mergedBase ??= settings;
    Object.assign(
      mergedAgents,
      (settings.agents as Record<string, unknown> | undefined) ?? {}
    );

    for (const channel of ((channels.enabled as string[] | undefined) ?? []).filter(Boolean)) {
      enabledChannels.add(channel);
    }

    if (channels.discord) {
      hasDiscordChannel = true;
    }
  }

  for (const input of inputs.filter((entry) => entry.kind === "team")) {
    if (!input.emittedFiles.some((file) => file.path === "tinyclaw-team.json")) {
      continue;
    }

    const teamConfig = parseJsonFile(input, "tinyclaw-team.json");
    Object.assign(
      mergedTeams,
      (teamConfig.teams as Record<string, unknown> | undefined) ?? {}
    );
  }

  const mergedSettings = {
    ...(mergedBase ?? {}),
    agents: mergedAgents,
    ...(Object.keys(mergedTeams).length > 0 ? { teams: mergedTeams } : {}),
    channels: {
      ...(((mergedBase?.channels as Record<string, unknown> | undefined) ?? {})),
      ...(hasDiscordChannel ? { discord: {} } : {}),
      enabled: [...enabledChannels].sort()
    },
    workspace: {
      ...(((mergedBase?.workspace as Record<string, unknown> | undefined) ?? {})),
      name: ((mergedBase?.workspace as Record<string, unknown> | undefined)?.name as string | undefined) ?? "workspace",
      path: WORKSPACE_PLACEHOLDER
    }
  };

  return [
    {
      files: [
        ...workspaceFiles,
        {
          content: `${JSON.stringify(mergedSettings, null, 2)}\n`,
          path: "settings.json"
        }
      ],
      configEnvBindings: resolveDiscordTokenBinding(agentInputs),
      id: "tinyclaw-runtime",
      sourceIds: agentInputs.map((input) => input.id)
    }
  ];
};

export const tinyClawAdapter: RuntimeAdapter = {
  assertSupportedModelTarget(target) {
    if (target.endpoint) {
      throw new SpawnfileError(
        "validation_error",
        "TinyClaw custom or local endpoints are not supported in Spawnfile v0.1"
      );
    }

    if (target.provider === "anthropic") {
      if (target.auth.method === "claude-code") {
        return;
      }
    } else if (target.provider === "openai") {
      if (target.auth.method === "codex") {
        return;
      }
    } else if (target.provider === "opencode" && target.auth.method === "none") {
      return;
    }

    throw new SpawnfileError(
      "validation_error",
      `TinyClaw does not support model auth method ${target.auth.method} for provider ${target.provider}`
    );
  },
  assertSupportedSurfaces(surfaces) {
    const access = surfaces?.discord?.access;
    if (!access) {
      return;
    }

    if (access.mode !== "pairing") {
      throw new SpawnfileError(
        "validation_error",
        "TinyClaw Discord only supports pairing access in Spawnfile v0.1"
      );
    }

    if (
      access.users.length > 0 ||
      access.guilds.length > 0 ||
      access.channels.length > 0
    ) {
      throw new SpawnfileError(
        "validation_error",
        "TinyClaw Discord does not support declarative users, guilds, or channels in Spawnfile v0.1"
      );
    }
  },
  container: {
    configFileName: "settings.json",
    configEnvBindings: [
      {
        envName: "ANTHROPIC_API_KEY",
        jsonPath: "models.anthropic.auth_token"
      },
      {
        envName: "OPENAI_API_KEY",
        jsonPath: "models.openai.auth_token"
      }
    ],
    homeEnv: "TINYAGI_HOME",
    globalNpmPackages: ["@anthropic-ai/claude-code", "@openai/codex"],
    instancePaths: {
      configPathTemplate: "<instance-root>/tinyagi/<config-file>",
      homePathTemplate: "<instance-root>/tinyagi",
      workspacePathTemplate: "<instance-root>/workspace"
    },
    port: 3777,
    portEnv: "TINYAGI_API_PORT",
    standaloneBaseImage: "node:22-bookworm-slim",
    startCommand: ["bash", "-lc", TINYCLAW_START_SCRIPT],
    systemDeps: ["bash", "ca-certificates", "curl", "g++", "make", "python3", "tar"]
  },
  async compileAgent(node): Promise<AdapterCompileResult> {
    return {
      capabilities: createAgentCapabilities(node, {
        mcpOutcome: node.mcpServers.length > 0 ? "degraded" : "supported"
      }),
      diagnostics: [],
      files: [
        ...createDocumentFiles(`workspace/${node.name}`, node.docs),
        ...createSkillFiles(`workspace/${node.name}/.agents/skills`, node.skills),
        ...createSkillFiles(`workspace/${node.name}/.claude/skills`, node.skills),
        {
          content: buildTinyClawSettings(node),
          path: "settings.json"
        }
      ]
    };
  },
  async createContainerTargets(inputs): Promise<ContainerTarget[]> {
    return mergeTinyClawTargets(inputs);
  },
  async compileTeam(node: ResolvedTeamNode): Promise<AdapterCompileResult> {
    const agentIds = node.members
      .filter((member) => member.kind === "agent")
      .map((member) => member.id);

    const teamConfig = {
      name: node.name,
      agents: agentIds,
      leader_agent: node.structure.leader ?? agentIds[0] ?? "leader"
    };

    return {
      capabilities: [
        createCapability("team.members", "supported"),
        createCapability("team.structure.mode", node.structure.mode === "hierarchical" ? "supported" : "degraded", "TinyClaw only supports leader-led teams"),
        createCapability("team.structure.leader", node.structure.leader ? "supported" : "degraded", "TinyClaw requires a leader_agent"),
        createCapability("team.structure.external", "degraded", "TinyClaw does not enforce external boundary"),
        createCapability("team.shared", "supported"),
        createCapability("team.nested", "degraded", "TinyClaw nested teams flatten in v0.1")
      ],
      diagnostics: [],
      files: [
        {
          content: `${JSON.stringify({ teams: { [node.name]: teamConfig } }, null, 2)}\n`,
          path: "tinyclaw-team.json"
        }
      ]
    };
  },
  name: "tinyclaw",
  prepareRuntimeAuth: prepareTinyClawRuntimeAuth,
  scaffoldAgentProject: createTinyClawAgentScaffold
};
