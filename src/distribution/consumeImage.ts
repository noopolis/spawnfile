import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  acquireHomeDeploymentLock,
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
  derivePersistentMountVolumeName,
  renderEnvFileContent,
  resolveImageEnvironment
} from "./consumeImageSupport.js";
import {
  acquireExclusiveVolumeReservations,
  assertCandidateContainerReady,
  assertContainerStopped,
  inspectContainerSnapshot,
  restorePreviousContainer,
  rollbackCandidateContainer
} from "./consumeImageLifecycle.js";
import { createConsumerDockerRunner } from "./dockerRunner.js";
import type { DockerCommandRunner } from "./dockerRunner.js";
import { extractImageReport, resolveDockerBaseArgs } from "./extractImage.js";
import { parseImageReference } from "./imageRef.js";
import { prepareImageRuntimeAuthMounts } from "./imageRuntimeAuth.js";
import { runImagePreflight } from "./preflight.js";
import { normalizeProjectLabelSlug } from "./projectName.js";
import type { DistributionReport } from "./types.js";
import type { ResolvedAuthProfile } from "../auth/index.js";

export interface ConsumeImageUpOptions {
  authProfile?: ResolvedAuthProfile | null;
  authValues?: Record<string, string>;
  /** See `ImageRuntimeAuthInput.daimonContainerCredentialUid`. */
  daimonContainerCredentialUid?: number;
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
  /** The ref/digest this redeploy replaced, or null for a first deploy. */
  previous: { digest: string | null; ref: string } | null;
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

  // Hold an exclusive lock for the whole operation so a concurrent `up` for the
  // same deployment cannot race on the record or orphan a container.
  const releaseLock = await acquireHomeDeploymentLock(deploymentName);
  try {
    return await consumeImageUpLocked(imageRef, parsedRef, deploymentName, isExplicitName, options);
  } finally {
    await releaseLock();
  }
};

const consumeImageUpLocked = async (
  imageRef: string,
  parsedRef: ReturnType<typeof parseImageReference>,
  deploymentName: string,
  isExplicitName: boolean,
  options: ConsumeImageUpOptions
): Promise<ConsumeImageUpResult> => {
  void parsedRef;
  const alreadyExists = await homeDeploymentExists(deploymentName);
  if (alreadyExists && !isExplicitName) {
    throw new SpawnfileError(
      "validation_error",
      `Deployment "${deploymentName}" already exists (derived from image ${imageRef}). ` +
        `To redeploy it, re-run with --deployment ${deploymentName}; ` +
        "to create a separate one, pass a different --deployment <name>."
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

  // Resolve the full environment first (auth profile, env file, process-env
  // overrides, and generated runtime tokens), then preflight against it so
  // required secrets supplied via any of those sources satisfy the check.
  const env = resolveImageEnvironment({
    authValues: options.authValues ?? {},
    envFileEnv: options.envFileEnv,
    report
  });
  const availableImports = options.authProfile
    ? (["claude-code", "codex"] as const).filter((kind) => options.authProfile!.imports[kind])
    : [];
  runImagePreflight({ authValues: env, availableImports, report });

  const target = await resolveExistingOrNewTarget(deploymentName, alreadyExists, options);

  // Capture what this redeploy replaces so the caller can show previous → new
  // ref/digest, per specs/DISTRIBUTION.md. Null on a first deploy.
  const previous = alreadyExists ? await readPreviousSource(deploymentName) : null;

  const runDocker = options.runDocker ?? createConsumerDockerRunner(dockerCommand, baseArgs);
  const containerName = containerNameFor(deploymentName);
  const projectSlug = normalizeProjectLabelSlug(report.organization.project);

  const workDir = await mkdtemp(path.join(os.tmpdir(), "spawnfile-consume-"));
  const envFilePath = path.join(workDir, "container.env");
  // A redeploy reuses the live container's published host ports, and Docker
  // cannot bind a host port twice. So when a live container exists we move it
  // aside (rename + stop) to free its name and ports, start the new container,
  // and on failure restore the old one — non-destructive without needing a free
  // port for two containers at once. There is a brief restart gap, unavoidable
  // when reusing host ports without a proxy.
  const backupName = `${containerName}-previous-${Date.now().toString(36)}`;
  let volumeReservation: Awaited<ReturnType<typeof acquireExclusiveVolumeReservations>> | undefined;
  try {
    await writeFile(envFilePath, renderEnvFileContent(env), "utf8");

    // Prepare import-based model auth (the consumer's Claude/Codex login) and
    // validate its credentials BEFORE the destructive swap below. The OAuth-mode
    // config is already baked into the image; this only resolves the credential
    // mounts. Doing it first guarantees an unusable import fails while the live
    // container is still untouched, never mid-swap.
    const authMountArgs = (
      await prepareImageRuntimeAuthMounts({
        authProfile: options.authProfile ?? null,
        ...(options.daimonContainerCredentialUid === undefined
          ? {}
          : { daimonContainerCredentialUid: options.daimonContainerCredentialUid }),
        report,
        tempRoot: workDir
      })
    ).mountArgs;

    volumeReservation = await acquireExclusiveVolumeReservations(
      report, deploymentName, containerName, imageRef, runDocker
    );
    const previousContainer = await inspectContainerSnapshot(runDocker, containerName);
    if (previousContainer !== null) {
      await runDocker(["rename", containerName, backupName]);
      try {
        await runDocker(["stop", backupName]);
        await assertContainerStopped(runDocker, backupName, previousContainer.id);
      } catch (error) {
        try {
          await restorePreviousContainer(runDocker, previousContainer, backupName, containerName);
        } catch {
          throw new SpawnfileError(
            "runtime_error",
            "Prior deployment stop failed and its original state could not be restored"
          );
        }
        throw error;
      }
    }

    const runArgs = ["run", "-d", "--name", containerName, "--env-file", envFilePath];
    for (const port of report.ports) {
      runArgs.push("-p", `${port}:${port}`);
    }
    for (const mount of report.persistent_mounts) {
      runArgs.push("-v", `${derivePersistentMountVolumeName(deploymentName, mount)}:${mount.target}`);
    }
    runArgs.push(...authMountArgs);
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

    let candidateId: string | undefined;
    try {
      const runOutput = (await runDocker(runArgs)).toString("utf8").trim();
      const observedId = runOutput.split("\n").pop()?.trim();
      if (!observedId || !/^[a-f0-9]{64}$/u.test(observedId)) {
        throw new SpawnfileError("runtime_error", "Candidate container returned invalid identity");
      }
      candidateId = observedId;
      await assertCandidateContainerReady(runDocker, candidateId, containerName);
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
            container_id: candidateId,
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
      if (previousContainer !== null) {
        await runDocker(["rm", "-f", previousContainer.id]).catch(() => undefined);
      }
      return {
        containerName,
        deploymentName,
        imageRef,
        previous,
        record,
        recordPath: written.recordPath
      };
    } catch (error) {
      try {
        await rollbackCandidateContainer(
          runDocker, candidateId, containerName, previousContainer, backupName
        );
      } catch (rollbackError) {
        throw rollbackError;
      }
      throw error;
    }
  } finally {
    try { await volumeReservation?.release(); }
    finally { await rm(workDir, { force: true, recursive: true }).catch(() => undefined); }
  }
};

const readPreviousSource = async (
  deploymentName: string
): Promise<{ digest: string | null; ref: string } | null> => {
  try {
    const existing = await readHomeDeploymentRecord(deploymentName);
    if (existing.source.kind !== "image") {
      return null;
    }
    return { digest: existing.source.digest, ref: existing.source.ref };
  } catch {
    return null;
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
