import path from "node:path";

import type { ModelAuthMethod } from "../shared/index.js";
import { SpawnfileError } from "../shared/index.js";
import type {
  ContainerTarget,
  ContainerTargetInput,
  EmittedFile,
  RuntimeContainerMeta
} from "../runtime/index.js";

import {
  listExecutionModelSecretNames,
  resolveExecutionModelAuthMethods
} from "./modelEnv.js";
import type { ResolvedPackage } from "./types.js";

const CONFIG_FILE_PLACEHOLDER = "<config-file>";
const INSTANCE_ROOT_PLACEHOLDER = "<instance-root>";

export const createDefaultTargets = (inputs: ContainerTargetInput[]): ContainerTarget[] =>
  inputs.map((input) => ({
    files: input.emittedFiles,
    id: `${input.kind}-${input.slug}`,
    sourceIds: [input.id]
  }));

export const resolveTargetEnvFiles = (
  configPath: string,
  target: ContainerTarget
): Array<{ envName: string; filePath: string }> =>
  (target.envFiles ?? []).map((binding) => ({
    envName: binding.envName,
    filePath: path.posix.join(path.posix.dirname(configPath), binding.relativePath)
  }));

export const resolveTargetConfigEnvBindings = (
  meta: RuntimeContainerMeta,
  target: ContainerTarget
): RuntimeContainerMeta["configEnvBindings"] =>
  [...(meta.configEnvBindings ?? []), ...(target.configEnvBindings ?? [])];

export const assertTargetHasConfig = (
  runtimeName: string,
  targetId: string,
  meta: RuntimeContainerMeta,
  files: EmittedFile[]
): void => {
  if (!files.some((file) => file.path === meta.configFileName)) {
    throw new SpawnfileError(
      "runtime_error",
      `Container target ${targetId} for ${runtimeName} is missing ${meta.configFileName}`
    );
  }
};

const createPackageIdentity = (pkg: ResolvedPackage): string =>
  `${pkg.manager}\u0000${pkg.name}\u0000${pkg.version ?? ""}\u0000${pkg.scope ?? ""}`;

const createPackageConflictIdentity = (pkg: ResolvedPackage): string =>
  `${pkg.manager}\u0000${pkg.name}`;

const createPackageLabel = (pkg: ResolvedPackage): string =>
  `${pkg.manager} package ${pkg.name}`;

export const resolveTargetPackages = (
  target: ContainerTarget,
  inputs: ContainerTargetInput[]
): ResolvedPackage[] => {
  const sourceIds = new Set(target.sourceIds ?? []);
  if (sourceIds.size === 0) return [];
  const byIdentity = new Map<string, ResolvedPackage>();
  for (const input of inputs) {
    if (!sourceIds.has(input.id) || input.value.kind !== "agent") continue;
    for (const currentPackage of input.value.packages ?? []) {
      const conflictIdentity = createPackageConflictIdentity(currentPackage);
      const existingPackage = byIdentity.get(conflictIdentity);
      if (!existingPackage) {
        byIdentity.set(conflictIdentity, currentPackage);
        continue;
      }
      if (createPackageIdentity(existingPackage) !== createPackageIdentity(currentPackage)) {
        throw new SpawnfileError(
          "validation_error",
          `Container target ${target.id} declares conflicting package definitions for ${createPackageLabel(currentPackage)}`
        );
      }
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    createPackageIdentity(left).localeCompare(createPackageIdentity(right))
  );
};

const replaceContainerPathTemplate = (
  template: string,
  instanceRoot: string,
  configFileName: string
): string =>
  template
    .replaceAll(INSTANCE_ROOT_PLACEHOLDER, instanceRoot)
    .replaceAll(CONFIG_FILE_PLACEHOLDER, configFileName);

export const resolveInstancePaths = (
  runtimeName: string,
  targetId: string,
  meta: RuntimeContainerMeta
): { configPath: string; homePath?: string; instanceRoot: string; workspacePath: string } => {
  const instanceRoot = `/var/lib/spawnfile/instances/${runtimeName}/${targetId}`;
  return {
    configPath: replaceContainerPathTemplate(
      meta.instancePaths.configPathTemplate,
      instanceRoot,
      meta.configFileName
    ),
    homePath: meta.instancePaths.homePathTemplate
      ? replaceContainerPathTemplate(
        meta.instancePaths.homePathTemplate,
        instanceRoot,
        meta.configFileName
      )
      : undefined,
    instanceRoot,
    workspacePath: replaceContainerPathTemplate(
      meta.instancePaths.workspacePathTemplate,
      instanceRoot,
      meta.configFileName
    )
  };
};

export const resolveTargetModelSecrets = (
  target: ContainerTarget,
  inputs: ContainerTargetInput[]
): string[] => {
  const sourceIds = new Set(target.sourceIds ?? []);
  if (sourceIds.size === 0) return [];
  const secretNames = new Set<string>();
  for (const input of inputs) {
    if (!sourceIds.has(input.id) || input.value.kind !== "agent") continue;
    for (const secretName of listExecutionModelSecretNames(input.value.execution)) {
      secretNames.add(secretName);
    }
  }
  return [...secretNames].sort();
};

export const resolveTargetModelAuthMethods = (
  target: ContainerTarget,
  inputs: ContainerTargetInput[]
): Record<string, ModelAuthMethod> => {
  const sourceIds = new Set(target.sourceIds ?? []);
  if (sourceIds.size === 0) return {};
  const methods = new Map<string, ModelAuthMethod>();
  for (const input of inputs) {
    if (!sourceIds.has(input.id) || input.value.kind !== "agent") continue;
    for (const [provider, method] of Object.entries(
      resolveExecutionModelAuthMethods(input.value.execution)
    )) {
      const existingMethod = methods.get(provider);
      if (existingMethod && existingMethod !== method) {
        throw new SpawnfileError(
          "validation_error",
          `Container target ${target.id} declares conflicting auth methods for provider ${provider}`
        );
      }
      methods.set(provider, method);
    }
  }
  return Object.fromEntries([...methods.entries()].sort(([left], [right]) => left.localeCompare(right)));
};

export const resolveTargetExposure = (
  target: ContainerTarget,
  inputs: ContainerTargetInput[]
): boolean => {
  const sourceIds = new Set(target.sourceIds ?? []);
  if (sourceIds.size === 0) return false;
  return inputs.some(
    (input) => sourceIds.has(input.id) && input.value.kind === "agent" && input.value.expose === true
  );
};
