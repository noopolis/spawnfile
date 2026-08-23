import path from "node:path";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";
import type { ContainerTarget, ContainerTargetInput, EmittedFile } from "../types.js";

import {
  DAIMON_AGY_SUBSCRIPTION_REALM,
  DAIMON_ENGINE_CREDENTIALS
} from "./contractManifest.js";

export const DAIMON_CONFIG_FILE = "daimon-organization-runtime.json";
export const DAIMON_CONTROL_PORT = 19700;
export const DAIMON_MAX_AGENTS = 32;
export const DAIMON_ORGANIZATION_TARGET_ID = "daimon-organization";
export const DAIMON_RUNTIME_HOMES_DIRECTORY = "runtime-homes";
const DAIMON_MAX_CONFIG_BYTES = 1_048_576;
const DAIMON_MAX_INSTRUCTION_BYTES = 16_384;
const DAIMON_MAX_INSTRUCTION_CODEPOINTS = 4_096;
export const DAIMON_ENGINES = ["agy", "codex", "grok"] as const;
type DaimonEngine = typeof DAIMON_ENGINES[number];

const formatInstructions = (node: ResolvedAgentNode): string =>
  node.docs.map((document) => `# ${document.role}\n\n${document.content}`).join("\n\n").trim() ||
  `You are ${node.name}. Follow the workspace instructions.`;

const assertPublicInstructionBounds = (agentId: string, instructions: string): void => {
  if (
    Buffer.byteLength(instructions, "utf8") > DAIMON_MAX_INSTRUCTION_BYTES ||
    [...instructions].length > DAIMON_MAX_INSTRUCTION_CODEPOINTS
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Daimon organization runtime v1 instructions for ${agentId} exceed Daimon's public config limit`
    );
  }
};

export const resolveDaimonEngine = (node: ResolvedAgentNode): DaimonEngine => {
  const engine = node.runtime.options.engine ?? "codex";
  if (typeof engine === "string" && (DAIMON_ENGINES as readonly string[]).includes(engine)) {
    return engine as DaimonEngine;
  }
  throw new SpawnfileError(
    "validation_error",
    `Daimon runtime option engine must be one of ${DAIMON_ENGINES.join(", ")}`
  );
};

const moveWorkspaceFile = (file: EmittedFile, slug: string): EmittedFile =>
  file.path.startsWith("workspace/")
    ? { ...file, path: path.posix.join("workspace", "agents", slug, file.path.slice("workspace/".length)) }
    : file;

const renderStartScript = (agents: Array<{
  engine: { kind: DaimonEngine };
  runtimeHomePath: string;
  workspacePath: string;
}>): string => {
  const setup = agents.flatMap((agent) => {
    const credential = agent.engine.kind === "agy"
      ? undefined
      : DAIMON_ENGINE_CREDENTIALS[agent.engine.kind];
    const inbound = path.posix.join(agent.runtimeHomePath, ".daimon-inbound");
    return [
      `install -d -m 700 ${[
        agent.workspacePath,
        agent.runtimeHomePath,
        ...(credential === undefined ? [] : [inbound])
      ].map((entry) => JSON.stringify(entry)).join(" ")}`,
      ...(credential === undefined ? [] : [
        `if [ -e ${JSON.stringify(path.posix.join(agent.runtimeHomePath, credential.sourceRelativePath))} ]; then test "$(stat -c %a ${JSON.stringify(path.posix.join(agent.runtimeHomePath, credential.sourceRelativePath))})" = 600; fi`
      ])
    ];
  });
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...setup,
    'if [ "$#" -gt 0 ]; then exec daimon-runtime "$@"; fi',
    "exec daimon-runtime run --config <config-path>"
  ].join("\n") + "\n";
};

export const createDaimonContainerTargets = async (
  inputs: ContainerTargetInput[]
): Promise<ContainerTarget[]> => {
  const agents = inputs.filter(
    (input): input is ContainerTargetInput & { value: ResolvedAgentNode } =>
      input.kind === "agent" && input.value.kind === "agent"
  );
  if (agents.length === 0) return [];
  if (agents.length > DAIMON_MAX_AGENTS) {
    throw new SpawnfileError(
      "validation_error",
      `Daimon organization runtime v1 supports at most 32 agents; found ${agents.length}. Split the organization across explicit runtime boundaries.`
    );
  }

  const configAgents = agents
    .map((input) => ({
      engine: { kind: resolveDaimonEngine(input.value) },
      id: input.id,
      instructions: formatInstructions(input.value),
      name: input.value.name,
      runtimeHomePath: `<instance-root>/${DAIMON_RUNTIME_HOMES_DIRECTORY}/${input.slug}`,
      workspacePath: `<workspace-path>/agents/${input.slug}`
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const engineByNodeId = Object.fromEntries(configAgents.map((agent) => [agent.id, agent.engine.kind]));
  const hasAgy = configAgents.some((agent) => agent.engine.kind === "agy");
  const agyRuntimeHomeMounts = configAgents
    .filter((agent) => agent.engine.kind === "agy")
    .map((agent) => ({
      id: `daimon-agy-runtime-home-${path.posix.basename(agent.runtimeHomePath)}`,
      mountPath: agent.runtimeHomePath,
      reason: `Daimon AGY subscription runtime home for ${agent.id}`
    }));
  for (const agent of configAgents) assertPublicInstructionBounds(agent.id, agent.instructions);
  const config = {
    agents: configAgents,
    host: {
      bindHost: "127.0.0.1",
      controlTokenEnv: "SPAWNFILE_DAIMON_CONTROL_TOKEN",
      port: DAIMON_CONTROL_PORT
    },
    version: "noopolis.daimon.organization-runtime.v1"
  };
  const serializedConfig = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serializedConfig, "utf8") > DAIMON_MAX_CONFIG_BYTES) {
    throw new SpawnfileError("validation_error", "Daimon organization runtime v1 config exceeds Daimon's public config limit");
  }

  return [{
    engineByNodeId,
    files: [
      ...agents.flatMap((input) => input.emittedFiles.map((file) => moveWorkspaceFile(file, input.slug))),
      { content: serializedConfig, path: DAIMON_CONFIG_FILE },
      {
        content: renderStartScript(configAgents),
        mode: 0o755,
        path: "runtime/daimon-start.sh"
      }
    ],
    id: DAIMON_ORGANIZATION_TARGET_ID,
    ...(hasAgy ? {
      opaqueMountTargets: [DAIMON_AGY_SUBSCRIPTION_REALM.unlockMountPath],
      persistentMounts: [{
        id: "daimon-agy-subscription-realm",
        mountPath: DAIMON_AGY_SUBSCRIPTION_REALM.durableMountPath,
        reason: "Daimon host AGY subscription realm"
      }, ...agyRuntimeHomeMounts]
    } : {}),
    sourceIds: agents.map((agent) => agent.id).sort()
  }];
};
