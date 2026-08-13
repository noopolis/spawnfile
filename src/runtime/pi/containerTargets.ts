import path from "node:path";

import { listExecutionModelSecretNames } from "../../compiler/modelEnv.js";
import type { ResolvedAgentNode } from "../../compiler/types.js";
import type {
  ContainerTarget,
  ContainerTargetInput,
  EmittedFile,
} from "../types.js";

import { renderPiScheduleSource } from "./appScheduleSource.js";
import {
  createPiAgentConfig,
  renderPiApp,
  renderPiAppConfig,
  renderPiModelsConfig,
  renderPiPackageJson,
  resolvePiEngine,
} from "./appTemplate.js";

export const PI_CONFIG_FILE = "pi-app.json";
export const PI_CONTROL_PORT = 19690;
const PI_MODELS_FILE = "home/.pi/agent/models.json";

const moveWorkspaceFileToAgentWorkspace = (
  file: EmittedFile,
  agentSlug: string,
): EmittedFile => {
  if (!file.path.startsWith("workspace/")) return file;
  return {
    ...file,
    path: path.posix.join(
      "workspace",
      "agents",
      agentSlug,
      file.path.slice("workspace/".length),
    ),
  };
};

export const createPiContainerTargets = async (
  inputs: ContainerTargetInput[],
): Promise<ContainerTarget[]> => {
  const agentInputs = inputs.filter(
    (input): input is ContainerTargetInput & { value: ResolvedAgentNode } =>
      input.kind === "agent" && input.value.kind === "agent",
  );
  if (agentInputs.length === 0) return [];

  const agents = agentInputs.map((input) =>
    createPiAgentConfig(input.value, input.slug, input.id, input.worldBinding)
  );
  const engineByNodeId = Object.fromEntries(
    agentInputs.map((input) => [input.id, resolvePiEngine(input.value).kind]),
  );
  const worldTokenEnvNames = agents
    .flatMap((agent) => agent.world ? [agent.world.tokenEnv] : [])
    .sort();
  const envFiles = [
    ...new Set(agentInputs.flatMap((input) =>
      listExecutionModelSecretNames(input.value.execution)
    )),
  ].map((secretName) => ({
    envName: secretName,
    relativePath: `secrets/${secretName}`,
  }));

  return [{
    engineByNodeId,
    envFiles,
    files: [
      ...agentInputs.flatMap((input) => input.emittedFiles.map((file) =>
        moveWorkspaceFileToAgentWorkspace(file, input.slug)
      )),
      { content: renderPiAppConfig(agents), path: PI_CONFIG_FILE },
      {
        content: renderPiModelsConfig(agentInputs.map((input) => input.value)),
        path: PI_MODELS_FILE,
      },
      { content: renderPiPackageJson(), path: "runtime/package.json" },
      {
        content: renderPiScheduleSource(),
        mode: 0o644,
        path: "runtime/schedule.mjs",
      },
      {
        content: renderPiApp({ world: agents.some((agent) => agent.world !== undefined) }),
        mode: 0o755,
        path: "runtime/app.mjs",
      },
    ],
    id: "pi-app",
    sourceIds: agentInputs.map((input) => input.id).sort(),
    ...(worldTokenEnvNames.length > 0 ? { worldTokenEnvNames } : {}),
  }];
};
