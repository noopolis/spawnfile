import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  createDockerDeploymentLabels,
  homeDeploymentExists,
  normalizeDeploymentName,
  readHomeDeploymentRecord,
  resolveDockerDeploymentTarget,
  verifyDockerDeploymentTarget,
  writeHomeDeployment,
  type DeploymentRecord,
  type DockerDeploymentTarget
} from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";

import {
  deriveDeploymentName,
  deriveVolumeName,
  renderEnvFileContent,
  resolveImageEnvironment
} from "./consumeImageSupport.js";
import { createConsumerDockerRunner } from "./dockerRunner.js";
import type { DockerCommandRunner } from "./dockerRunner.js";
import { extractImageReport, resolveDockerBaseArgs } from "./extractImage.js";
import { parseImageReference } from "./imageRef.js";
import { runImagePreflight } from "./preflight.js";
import { normalizeProjectLabelSlug } from "./projectName.js";
import type { DistributionReport } from "./types.js";

export interface ConsumeImageUpOptions {
  authValues?: Record<string, string>;
  authProfileName?: string | null;
  deploymentName?: string;
  dockerCommand?: string;
  dockerContext?: string;
  dockerHost?: string;
  envFileEnv?: Record<string, string>;
  envFilePath?: string | null;
  pull?: boolean;
  runDocker?: DockerCommandRunner;
}

export interface ConsumeImageUpResult {
  containerName: string;
  deploymentName: string;
  imageRef: string;
  record: DeploymentRecord;
  recordPath: string;
}

const containerNameFor = (deploymentName: string): string =>
  `spawnfile-${deploymentName}`;

const unitIdFor = (deploymentName: string): string => `${deploymentName}-container`;

const resolveRegistryDigest = async (
  imageRef: string,
  runDocker: DockerCommandRunner
): Promise<string | null> => {
  const fromRef = imageRef.includes("@") ? imageRef.slice(imageRef.indexOf("@") + 1) : null;
  if (fromRef) {
    return fromRef;
  }
  try {
    const raw = (await runDocker([
      "image",
      "inspect",
      "--format",
      "{{json .RepoDigests}}",
      imageRef
    ])).toString("utf8").trim();
    const digests = JSON.parse(raw) as string[];
    const match = digests
      .map((entry) => (entry.includes("@") ? entry.slice(entry.indexOf("@") + 1) : null))
      .find((entry): entry is string => Boolean(entry));
    return match ?? null;
  } catch {
    return null;
  }
};

const resolveLocalImageId = async (
  imageRef: string,
  runDocker: DockerCommandRunner
): Promise<string | null> => {
  try {
    const raw = (await runDocker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      imageRef
    ])).toString("utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
};

const networkIdsFrom = (report: DistributionReport): string[] =>
  report.moltnet.networks.map((network) => network.id).sort();

const buildContainsEntries = (
  report: DistributionReport
): DeploymentRecord["units"][number]["contains"] => [
  ...report.organization.agents.map((agent) => ({ id: agent.id, kind: "agent" as const })),
  ...report.organization.teams.map((team) => ({ id: team.id, kind: "team" as const })),
  ...networkIdsFrom(report).map((id) => ({ id, kind: "network" as const }))
];

export const consumeImageUp = async (
  imageRef: string,
  options: ConsumeImageUpOptions = {}
): Promise<ConsumeImageUpResult> => {
  const parsedRef = parseImageReference(imageRef);
  if (!parsedRef) {
    throw new SpawnfileError("validation_error", `Invalid image reference: ${imageRef}`);
  }

  const deploymentName = normalizeDeploymentName(
    options.deploymentName ?? deriveDeploymentName(parsedRef)
  );
  const isExplicitName = Boolean(options.deploymentName);
  const alreadyExists = await homeDeploymentExists(deploymentName);
  if (alreadyExists && !isExplicitName) {
    throw new SpawnfileError(
      "validation_error",
      `Deployment "${deploymentName}" already exists; pass --deployment to redeploy it explicitly`
    );
  }

  const dockerCommand = options.dockerCommand ?? "docker";
  const baseArgs = resolveDockerBaseArgs({
    dockerContext: options.dockerContext,
    dockerHost: options.dockerHost
  });

  const inspection = await extractImageReport(imageRef, {
    dockerCommand,
    dockerContext: options.dockerContext,
    dockerHost: options.dockerHost,
    pull: options.pull,
    runDocker: options.runDocker
  });
  const report = inspection.report;

  const authValues = options.authValues ?? {};
  runImagePreflight({ authValues, report });

  const target = await resolveExistingOrNewTarget(deploymentName, alreadyExists, options);

  const env = resolveImageEnvironment({
    authValues,
    envFileEnv: options.envFileEnv,
    report
  });

  const runDocker = options.runDocker ?? createConsumerDockerRunner(dockerCommand, baseArgs);
  const containerName = containerNameFor(deploymentName);
  const projectSlug = normalizeProjectLabelSlug(report.organization.project);

  const workDir = await mkdtemp(path.join(os.tmpdir(), "spawnfile-consume-"));
  const envFilePath = path.join(workDir, "container.env");
  try {
    await writeFile(envFilePath, renderEnvFileContent(env), "utf8");

    await runDocker(["rm", "-f", containerName]).catch(() => undefined);

    const runArgs = ["run", "-d", "--name", containerName, "--env-file", envFilePath];
    for (const port of report.ports) {
      runArgs.push("-p", `${port}:${port}`);
    }
    for (const mount of report.persistent_mounts) {
      runArgs.push("-v", `${deriveVolumeName(deploymentName, mount.id)}:${mount.target}`);
    }
    const labels = createDockerDeploymentLabels({
      compileFingerprint: inspection.compileFingerprint,
      deployment: deploymentName,
      project: projectSlug,
      unit: unitIdFor(deploymentName),
      version: "0.1"
    });
    for (const [name, value] of Object.entries(labels)) {
      runArgs.push("--label", `${name}=${value}`);
    }
    runArgs.push(imageRef);

    const runOutput = (await runDocker(runArgs)).toString("utf8").trim();
    const containerId = runOutput.split("\n").pop()?.trim() || null;
    const imageId = await resolveLocalImageId(imageRef, runDocker);
    const digest = await resolveRegistryDigest(imageRef, runDocker);

    const record: DeploymentRecord = {
      auth_profile: options.authProfileName ?? null,
      compile_fingerprint: inspection.compileFingerprint,
      created_at: new Date().toISOString(),
      ...(options.envFilePath ? { env_file: path.resolve(options.envFilePath) } : {}),
      manager: "docker",
      name: deploymentName,
      output_directory: null,
      source: { digest, kind: "image", ref: imageRef },
      target,
      units: [
        {
          container_id: containerId,
          container_name: containerName,
          contains: buildContainsEntries(report),
          id: unitIdFor(deploymentName),
          image_id: imageId,
          image_tag: imageRef,
          kind: "container",
          runtime_instances: report.runtime_instances.map((instance) => instance.id).sort()
        }
      ],
      version: "spawnfile.deployment.v2"
    };

    const written = await writeHomeDeployment(record, report);
    return {
      containerName,
      deploymentName,
      imageRef,
      record,
      recordPath: written.recordPath
    };
  } finally {
    await rm(workDir, { force: true, recursive: true }).catch(() => undefined);
  }
};

const resolveExistingOrNewTarget = async (
  deploymentName: string,
  alreadyExists: boolean,
  options: ConsumeImageUpOptions
): Promise<DockerDeploymentTarget> => {
  if (alreadyExists && !options.dockerContext && !options.dockerHost) {
    const existing = await readHomeDeploymentRecord(deploymentName);
    await verifyDockerDeploymentTarget(existing.target, { dockerCommand: options.dockerCommand });
    return existing.target;
  }
  return resolveDockerDeploymentTarget({
    context: options.dockerContext ?? null,
    dockerCommand: options.dockerCommand,
    dockerHost: options.dockerHost ?? null
  });
};
