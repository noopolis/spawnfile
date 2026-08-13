import path from "node:path";

import {
  getManifestPath,
  writeUtf8File
} from "../filesystem/index.js";
import {
  type AgentManifest,
  type ExecutionBlock,
  type InlineAgentMember,
  type ModelTarget,
  type TeamManifest,
  loadManifest,
  renderSpawnfile
} from "../manifest/index.js";
import {
  type ModelAuthMethod,
  type ModelEndpointCompatibility,
  SpawnfileError
} from "../shared/index.js";

import { resolveEffectiveModelTarget } from "./modelEnv.js";
import {
  collectProjectManifestPaths,
  createInlineAgentSource,
  rewriteInlineAgentMembers
} from "./projectManifestGraph.js";

type ProjectManifest = AgentManifest | TeamManifest;
type AgentModelDeclaration = AgentManifest | InlineAgentMember;

export interface ProjectModelTargetOptions {
  authKey?: string;
  authMethod?: ModelAuthMethod;
  endpointBaseUrl?: string;
  endpointCompatibility?: ModelEndpointCompatibility;
  name: string;
  path?: string;
  provider: string;
  recursive?: boolean;
}

export interface UpdateProjectModelsResult {
  updatedFiles: string[];
}

const TEAM_MODEL_COMMAND_ERROR =
  "spawnfile model commands only write agent manifests; use --recursive to update descendant agents of a team project";
const AUTH_METHOD_PROVIDER_HINTS: Record<ModelAuthMethod, string> = {
  "api_key": "use a model provider like openai or anthropic, then pass --auth api_key",
  "claude-code": "use provider anthropic, then pass --auth claude-code",
  codex: "use provider openai, then pass --auth codex",
  none: "use a model provider like local, then pass --auth none"
};

const resolveTargetManifestPath = (inputPath?: string): string =>
  getManifestPath(path.resolve(inputPath ?? process.cwd()));

const toModelTarget = (
  target: ReturnType<typeof resolveEffectiveModelTarget>
): ModelTarget => ({
  ...(target.endpoint ? { endpoint: target.endpoint } : {}),
  auth: target.auth,
  name: target.name,
  provider: target.provider
});

const normalizeExecutionModel = (
  execution: ExecutionBlock | undefined
): ExecutionBlock["model"] | undefined => {
  if (!execution?.model?.primary) {
    return undefined;
  }

  const executionWithModel: ExecutionBlock = { model: execution.model };

  return {
    ...(execution.model.fallback
      ? {
          fallback: execution.model.fallback.map((target) =>
            toModelTarget(resolveEffectiveModelTarget(target, executionWithModel))
          )
        }
      : {}),
    primary: toModelTarget(
      resolveEffectiveModelTarget(execution.model.primary, executionWithModel)
    )
  };
};

const buildModelTarget = (options: ProjectModelTargetOptions): ModelTarget => {
  const usesEndpoint = options.provider === "custom" || options.provider === "local";
  const hasEndpointInput = Boolean(options.endpointBaseUrl || options.endpointCompatibility);
  const authMethodHint = AUTH_METHOD_PROVIDER_HINTS[options.provider as ModelAuthMethod];

  if (authMethodHint) {
    throw new SpawnfileError(
      "validation_error",
      `Model provider must not be an auth method: ${options.provider}; ${authMethodHint}`
    );
  }

  if (options.authKey && options.authMethod !== "api_key") {
    throw new SpawnfileError(
      "validation_error",
      "Model auth key is only valid with api_key auth"
    );
  }

  if (!usesEndpoint && hasEndpointInput) {
    throw new SpawnfileError(
      "validation_error",
      "Only custom and local models accept --base-url and --compat"
    );
  }

  if (usesEndpoint && (!options.endpointBaseUrl || !options.endpointCompatibility)) {
    throw new SpawnfileError(
      "validation_error",
      `${options.provider} models require both --base-url and --compat`
    );
  }

  if (options.provider === "custom" && !options.authMethod) {
    throw new SpawnfileError(
      "validation_error",
      "Custom models require --auth"
    );
  }

  if (usesEndpoint && options.authMethod === "api_key" && !options.authKey) {
    throw new SpawnfileError(
      "validation_error",
      `${options.provider} api_key auth requires --key`
    );
  }

  return {
    ...(options.authMethod
      ? {
          auth: {
            ...(options.authKey ? { key: options.authKey } : {}),
            method: options.authMethod
          }
        }
      : {}),
    ...(usesEndpoint
      ? {
          endpoint: {
            base_url: options.endpointBaseUrl!,
            compatibility: options.endpointCompatibility!
          }
        }
      : {}),
    name: options.name,
    provider: options.provider
  };
};

const updateManifestExecution = (
  manifest: AgentModelDeclaration,
  model: ExecutionBlock["model"]
): AgentModelDeclaration => ({
  ...manifest,
  execution: {
    ...manifest.execution,
    model
  }
});

const manifestChanged = (current: ProjectManifest, next: ProjectManifest): boolean =>
  JSON.stringify(current) !== JSON.stringify(next);

const mutateAgentDeclarations = (
  manifest: ProjectManifest,
  manifestPath: string,
  recursive: boolean,
  mutate: (
    declaration: AgentModelDeclaration,
    source: string
  ) => AgentModelDeclaration | null
): ProjectManifest | null => {
  if (manifest.kind === "agent") {
    return mutate(manifest, manifestPath) as AgentManifest | null;
  }

  if (!recursive) {
    throw new SpawnfileError("validation_error", TEAM_MODEL_COMMAND_ERROR);
  }

  return rewriteInlineAgentMembers(manifest, (member) =>
    (mutate(
      member,
      createInlineAgentSource(manifestPath, member.id)
    ) as InlineAgentMember | null) ?? member
  );
};

const rewriteTouchedManifests = async (
  manifestPaths: string[],
  mutate: (manifest: ProjectManifest, manifestPath: string) => ProjectManifest | null
): Promise<UpdateProjectModelsResult> => {
  const updatedFiles: string[] = [];

  for (const manifestPath of manifestPaths) {
    const loadedManifest = await loadManifest(manifestPath);
    const nextManifest = mutate(loadedManifest.manifest, manifestPath);
    if (!nextManifest || !manifestChanged(loadedManifest.manifest, nextManifest)) {
      continue;
    }

    await writeUtf8File(manifestPath, renderSpawnfile(nextManifest));
    updatedFiles.push(manifestPath);
  }

  return { updatedFiles };
};

export const setProjectPrimaryModel = async (
  options: ProjectModelTargetOptions
): Promise<UpdateProjectModelsResult> => {
  const modelTarget = buildModelTarget(options);
  const recursive = options.recursive ?? false;
  const manifestPaths = await collectProjectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest, manifestPath) => {
    return mutateAgentDeclarations(manifest, manifestPath, recursive, (declaration) => {
      const normalizedModel = normalizeExecutionModel(declaration.execution);
      return updateManifestExecution(declaration, {
        ...(normalizedModel?.fallback ? { fallback: normalizedModel.fallback } : {}),
        primary: modelTarget
      });
    });
  });
};

export const addProjectModelFallback = async (
  options: ProjectModelTargetOptions
): Promise<UpdateProjectModelsResult> => {
  const modelTarget = buildModelTarget(options);
  const recursive = options.recursive ?? false;
  const manifestPaths = await collectProjectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest, manifestPath) => {
    return mutateAgentDeclarations(manifest, manifestPath, recursive, (declaration, source) => {
      const normalizedModel = normalizeExecutionModel(declaration.execution);
      if (!normalizedModel) {
        if (recursive) {
          return null;
        }

        throw new SpawnfileError(
          "validation_error",
          `Manifest at ${source} must declare a primary model before adding fallback models`
        );
      }

      const existingFallback = normalizedModel.fallback ?? [];
      const nextFallback = existingFallback.some(
        (entry) => JSON.stringify(entry) === JSON.stringify(modelTarget)
      )
        ? existingFallback
        : [...existingFallback, modelTarget];

      return updateManifestExecution(declaration, {
        fallback: nextFallback,
        primary: normalizedModel.primary
      });
    });
  });
};

export const clearProjectModelFallbacks = async (options: {
  path?: string;
  recursive?: boolean;
} = {}): Promise<UpdateProjectModelsResult> => {
  const recursive = options.recursive ?? false;
  const manifestPaths = await collectProjectManifestPaths(
    resolveTargetManifestPath(options.path),
    recursive
  );

  return rewriteTouchedManifests(manifestPaths, (manifest, manifestPath) => {
    return mutateAgentDeclarations(manifest, manifestPath, recursive, (declaration, source) => {
      const normalizedModel = normalizeExecutionModel(declaration.execution);
      if (!normalizedModel) {
        if (recursive) {
          return null;
        }

        throw new SpawnfileError(
          "validation_error",
          `Manifest at ${source} does not declare any execution model`
        );
      }

      return updateManifestExecution(declaration, {
        primary: normalizedModel.primary
      });
    });
  });
};
