import path from "node:path";

import { normalizeProjectLabelSlug } from "../distribution/index.js";
import type { DeploymentRecordSource } from "./record.js";
import { SpawnfileError } from "../shared/index.js";

import { normalizeDeploymentName } from "./names.js";
import {
  resolveDockerDeploymentTarget,
  type DockerDeploymentTarget,
  type DockerTargetExecFile
} from "./target.js";
import { writeDeploymentRecord, type DeploymentRecord } from "./record.js";

export interface DockerDeploymentNodeInput {
  id: string;
  kind: "agent" | "team";
}

export interface DockerDeploymentRunMetadata {
  containerId?: string;
  imageId?: string;
}

export interface DockerDeploymentRunInvocationInput {
  command: string;
  containerName: string | null;
  deploymentName?: string | null;
  detach: boolean;
  dockerContext?: string | null;
  dockerHost?: string | null;
}

export interface DockerDeploymentReportInput {
  compile_fingerprint?: string;
  container?: {
    runtime_instances: Array<{ id: string }>;
  };
  nodes: DockerDeploymentNodeInput[];
  root: string;
}

export interface WriteDockerDeploymentRecordInput {
  authProfileName: string | null;
  compileFingerprint: string;
  containerName: string | null;
  deploymentName?: string;
  envFilePath?: string;
  imageTag: string;
  nodes: DockerDeploymentNodeInput[];
  outputDirectory: string;
  projectRoot: string;
  runMetadata?: DockerDeploymentRunMetadata;
  runtimeInstanceIds: string[];
  source?: DeploymentRecordSource;
  target: DockerDeploymentTarget;
}

const resolveProjectSlug = (projectRoot: string): string => {
  const base = path.basename(projectRoot).toLowerCase() === "spawnfile"
    ? path.basename(path.dirname(projectRoot))
    : path.basename(projectRoot);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
};

export const createDockerDeploymentUnitId = (deploymentName: string): string =>
  `${deploymentName}-container`;

export const createDockerDeploymentRecord = (
  input: WriteDockerDeploymentRecordInput
): DeploymentRecord => {
  const name = normalizeDeploymentName(input.deploymentName);
  return {
    auth_profile: input.authProfileName,
    compile_fingerprint: input.compileFingerprint,
    created_at: new Date().toISOString(),
    ...(input.envFilePath ? { env_file: path.resolve(input.envFilePath) } : {}),
    manager: "docker",
    name,
    output_directory: path.resolve(input.outputDirectory),
    source: input.source ?? { kind: "project", root: path.resolve(input.projectRoot) },
    target: input.target,
    units: [
      {
        container_id: input.runMetadata?.containerId ?? null,
        container_name: input.containerName,
        contains: input.nodes.map((node) => ({ id: node.id, kind: node.kind })),
        id: createDockerDeploymentUnitId(name),
        image_id: input.runMetadata?.imageId ?? null,
        image_tag: input.imageTag,
        kind: "container",
        runtime_instances: [...input.runtimeInstanceIds].sort()
      }
    ],
    version: "spawnfile.deployment.v2"
  };
};

export const createDockerProjectLabel = (
  projectRoot: string,
  projectName?: string
): string =>
  projectName ? normalizeProjectLabelSlug(projectName) : resolveProjectSlug(projectRoot);

const requireCompileFingerprint = (fingerprint: string | undefined): string => {
  if (!fingerprint) {
    throw new SpawnfileError(
      "validation_error",
      "Detached deployment records require compile_fingerprint in the compile report"
    );
  }

  return fingerprint;
};

export const writeDockerDeploymentRecord = async (
  input: WriteDockerDeploymentRecordInput
): Promise<string> =>
  writeDeploymentRecord(input.outputDirectory, createDockerDeploymentRecord(input));

export const writeDockerDeploymentRecordForRun = async (input: {
  authProfileName: string | null;
  envFilePath?: string;
  imageTag: string;
  invocation: DockerDeploymentRunInvocationInput;
  outputDirectory: string;
  report: DockerDeploymentReportInput;
  runMetadata?: DockerDeploymentRunMetadata;
  targetExecFile?: DockerTargetExecFile;
  targetTimeoutMs?: number;
}): Promise<string | null> => {
  if (!input.invocation.detach || !input.invocation.deploymentName) {
    return null;
  }

  return writeDockerDeploymentRecord({
    authProfileName: input.authProfileName,
    compileFingerprint: requireCompileFingerprint(input.report.compile_fingerprint),
    containerName: input.invocation.containerName,
    deploymentName: input.invocation.deploymentName,
    envFilePath: input.envFilePath,
    imageTag: input.imageTag,
    nodes: input.report.nodes,
    outputDirectory: input.outputDirectory,
    projectRoot: input.report.root,
    runMetadata: input.runMetadata,
    runtimeInstanceIds: input.report.container?.runtime_instances.map((instance) => instance.id) ?? [],
    target: await resolveDockerDeploymentTarget({
      context: input.invocation.dockerContext ?? undefined,
      dockerCommand: input.invocation.command,
      dockerHost: input.invocation.dockerHost ?? undefined,
      execFile: input.targetExecFile,
      timeoutMs: input.targetTimeoutMs
    })
  });
};
