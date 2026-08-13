import path from "node:path";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  createOrganizationReadinessPending,
  createDockerOrganizationHandoffSession,
  createDockerDeploymentRecord,
  initializeOrganizationHandoffAuthorityStore,
  parseCanonicalSha256Digest,
  probeDockerOrganizationReadiness,
  readDeploymentRecord,
  resolveDockerDeploymentTarget,
  resolveDeploymentRecordPath,
  type DockerTargetExecFile,
  type OrganizationHandoffCapabilityPending,
  type OrganizationHandoffInput,
  writeDeploymentRecord,
  writeDockerDeploymentRecordForRun
} from "../deployment/index.js";
import { createCanonicalSelectedTargetReceiptBytes, parseOpaqueTargetHandle, parseRunId, parseSelectedTargetReceipt, selectTarget, type OpaqueTargetHandle, type SelectedTargetReceipt } from "../target/index.js";

import {
  buildProject,
  type BuildProjectResult,
  type DockerBuildRunner
} from "./buildProject.js";
import {
  createDockerRunInvocation,
  resolveDetachedDeploymentOptions,
  runDockerContainer,
  type DockerRunResult,
  type DockerRunRunner
} from "./runProject.js";
import { executeDockerRunWithSupportCleanup } from "./runProjectLifecycle.js";
import { requireAuthProfile } from "../auth/index.js";
import { CompileProjectOptions } from "./compileProject.js";
import { DEFAULT_OUTPUT_DIRECTORY, SpawnfileError } from "../shared/index.js";
import { ensureNoopolisRunId, resolveNoopolisRunId } from "../runtime/index.js";
import { fileExists } from "../filesystem/index.js";
import { resolveHostCliCredential } from "./runProjectAuth.js";

export interface UpProjectOptions extends CompileProjectOptions {
  authProfile?: string;
  buildRunner?: DockerBuildRunner;
  containerName?: string;
  detach?: boolean;
  deploymentName?: string;
  dockerCommand?: string;
  dockerContext?: string;
  dockerHost?: string;
  envFilePath?: string;
  imageTag?: string;
  runRunner?: DockerRunRunner;
  networkAttachmentHandle?: string;
  organizationHandoffRunId?: string;
  descriptorDigest?: string;
  selectedTargetReceipt?: unknown;
  selectedTargetReceiptDigest?: string;
  targetExecFile?: DockerTargetExecFile;
}

export interface UpProjectResult extends BuildProjectResult {
  authProfileName: string | null;
  containerName: string | null;
  deploymentRecordPath?: string | null;
  supportDirectory: string | null;
}

const handoffInputError = (): SpawnfileError =>
  new SpawnfileError(
    "validation_error",
    "Organization handoff requires authorized run id, selected target receipt, descriptor digest, selected target receipt digest, network attachment handle, and world bindings"
  );

const handoffRecoveryIncompleteError = (): SpawnfileError =>
  new SpawnfileError(
    "runtime_error",
    "Organization handoff recovery is incomplete; redeploy with explicit authorization"
  );

interface RequestedHandoff extends Omit<OrganizationHandoffInput, "bindingDigest"> {
  descriptorDigest: string;
  runId: string;
  selectedTarget: SelectedTargetReceipt;
}
interface CompiledHandoff {
  authority: RequestedHandoff & { bindingDigest: string };
  organizationHandoff: OrganizationHandoffInput;
}

const stableRecord = (record: Awaited<ReturnType<typeof readDeploymentRecord>>) => {
  const { created_at: _createdAt, export_index: _exportIndex, organization_ready: _organizationReady, ...stable } = record;
  return stable;
};
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw handoffInputError();
  return serialized;
};

const resolveRequestedHandoff = (
  options: UpProjectOptions
): RequestedHandoff | null => {
  const values = [
    options.descriptorDigest,
    options.organizationHandoffRunId,
    options.selectedTargetReceiptDigest,
    options.selectedTargetReceipt,
    options.networkAttachmentHandle,
    options.worldBindingsPath
  ];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined) || !options.detach) throw handoffInputError();

  try {
    const selectedTarget = parseSelectedTargetReceipt(options.selectedTargetReceipt);
    const selectedDigest = parseCanonicalSha256Digest(options.selectedTargetReceiptDigest, "selected_target_receipt_digest");
    const computedDigest = `sha256:${createHash("sha256").update(createCanonicalSelectedTargetReceiptBytes(selectedTarget), "utf8").digest("hex")}`;
    if (selectedDigest !== computedDigest) throw new Error("selected receipt digest mismatch");
    return {
      descriptorDigest: parseCanonicalSha256Digest(options.descriptorDigest, "descriptor_digest"),
      runId: parseRunId(options.organizationHandoffRunId),
      networkAttachmentHandle: parseOpaqueTargetHandle(options.networkAttachmentHandle),
      selectedTarget,
      selectedTargetReceiptDigest: selectedDigest
    };
  } catch {
    throw handoffInputError();
  }
};

const verifyRequestedHandoffTarget = async (
  requested: RequestedHandoff | null,
  resolved: { readonly dockerContext?: string | null; readonly dockerHost?: string | null },
  options: Pick<UpProjectOptions, "dockerCommand" | "targetExecFile">
): Promise<void> => {
  if (!requested) return;
  if (typeof resolved.dockerContext !== "string" || resolved.dockerContext.length === 0
    || resolved.dockerHost != null || process.env.DOCKER_HOST != null) throw handoffInputError();
  try {
    const actual = await selectTarget({
      context: resolved.dockerContext,
      dockerCommand: options.dockerCommand,
      execFile: options.targetExecFile
    });
    if (createCanonicalSelectedTargetReceiptBytes(actual)
      !== createCanonicalSelectedTargetReceiptBytes(requested.selectedTarget)) throw new Error("target mismatch");
  } catch {
    throw handoffInputError();
  }
};

const resolveCompiledHandoff = (
  requested: RequestedHandoff | null,
  buildResult: BuildProjectResult
): CompiledHandoff | undefined => {
  if (!requested) return undefined;
  try {
    const bindingDigest = buildResult.organizationReadinessEvidence.worldBindings?.digest;
    if (!bindingDigest) throw new Error("missing compiled binding evidence");
    const bindingDigestParsed = parseCanonicalSha256Digest(bindingDigest, "binding_digest");
    return { authority: { ...requested, bindingDigest: bindingDigestParsed }, organizationHandoff: {
      bindingDigest: bindingDigestParsed, networkAttachmentHandle: requested.networkAttachmentHandle,
      selectedTargetReceiptDigest: requested.selectedTargetReceiptDigest } };
  } catch {
    throw handoffInputError();
  }
};

export const upProject = async (
  inputPath: string,
  options: UpProjectOptions = {}
): Promise<UpProjectResult> => {
  // Parse caller authority before any target or build work. Target identity is
  // verified below from the resolved detached options, including exact record reuse.
  const requestedHandoff = resolveRequestedHandoff(options);
  // Handoff reservation identity must survive a process crash.  Unlike an
  // ordinary deployment run, it may never silently mint a fresh run id.
  if (requestedHandoff && resolveNoopolisRunId(process.env) !== requestedHandoff.runId) throw handoffInputError();
  const resolvedOptions = await resolveDetachedDeploymentOptions(
    path.resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY),
    {
      authProfile: options.authProfile,
      containerName: options.containerName,
      deploymentName: options.deploymentName,
      detach: options.detach,
      dockerCommand: options.dockerCommand,
      dockerContext: options.dockerContext,
      dockerHost: options.dockerHost,
      envFilePath: options.envFilePath,
      imageTag: options.imageTag,
      targetExecFile: options.targetExecFile
    }
  );
  await verifyRequestedHandoffTarget(requestedHandoff, resolvedOptions, options);
  // Every authority container compiled for this deployment must stamp
  // causal events under the same real run id (see specs/CAUSAL.md).
  // buildProject/compileProject stay deterministic functions of the host
  // env; this only fills in a generated id when the host did not already
  // provide one, before the build step that bakes it into the
  // entrypoint/recipe env.
  if (!requestedHandoff) ensureNoopolisRunId();
  const buildResult = await buildProject(inputPath, {
    buildRunner: options.buildRunner,
    clean: options.clean,
    containerArchitecture: options.containerArchitecture,
    dockerContext: resolvedOptions.dockerContext,
    dockerCommand: options.dockerCommand,
    imageTag: resolvedOptions.imageTag,
    outputDirectory: options.outputDirectory,
    runtimePackageOverrides: options.runtimePackageOverrides,
    ...(options.worldBindingsPath !== undefined
      ? { worldBindingsPath: options.worldBindingsPath }
      : {})
  });
  const handoff = resolveCompiledHandoff(requestedHandoff, buildResult);
  const authProfile = resolvedOptions.authProfile
    ? await requireAuthProfile(resolvedOptions.authProfile)
    : null;
  const cliCredential = await resolveHostCliCredential(buildResult.report.container!);
  const imageTag = resolvedOptions.imageTag ?? buildResult.imageTag;
  const invocation = await createDockerRunInvocation(buildResult, imageTag, {
    authProfile,
    ...(cliCredential ? { cliCredential: { name: cliCredential.name, value: cliCredential.value } } : {}),
    containerName: resolvedOptions.containerName,
    detach: options.detach,
    deploymentName: resolvedOptions.deploymentName,
    dockerCommand: options.dockerCommand,
    dockerContext: resolvedOptions.dockerContext,
    dockerHost: resolvedOptions.dockerHost,
    envFilePath: resolvedOptions.envFilePath
  });

  let authority: Awaited<ReturnType<typeof initializeOrganizationHandoffAuthorityStore>> | undefined;
  let deploymentRecordPath: string | null;
  let recovered = false;
  let dockerLifecycleInvoked = false;
  try {
    let pending: OrganizationHandoffCapabilityPending | undefined;
    if (handoff) {
      if (!invocation.deploymentLabels || !invocation.containerName) throw handoffInputError();
      const session = createDockerOrganizationHandoffSession({
        bindingDigest: handoff.authority.bindingDigest,
        containerName: invocation.containerName,
        deploymentLabels: invocation.deploymentLabels,
        descriptorDigest: handoff.authority.descriptorDigest,
        organizationHandoff: handoff.organizationHandoff,
        runId: handoff.authority.runId,
        selectedTarget: handoff.authority.selectedTarget,
        selectedTargetReceiptDigest: handoff.authority.selectedTargetReceiptDigest
      });
      authority = await initializeOrganizationHandoffAuthorityStore();
      const begun = await authority.begin(session.authorityInput);
      pending = begun.pending;
      recovered = !begun.created;
    }
    let runMetadata: DockerRunResult | void = undefined;
    if (!recovered) {
      dockerLifecycleInvoked = true;
      runMetadata = await executeDockerRunWithSupportCleanup(invocation, options.runRunner ?? runDockerContainer);
    }
    const observed = recovered && authority && pending
      ? await authority.readDockerMutation(pending.pending_key)
      : undefined;
    if (recovered && !observed) throw handoffRecoveryIncompleteError();
    const recoveredMetadata: DockerRunResult | void = observed
      ? { containerId: observed.container_id, deploymentLabels: observed.deployment_labels, imageId: observed.image_id }
      : undefined;
    const exactRunMetadata = runMetadata ?? recoveredMetadata;
    let organizationHandoffHandle: OpaqueTargetHandle | undefined;
    if (handoff) {
      if (!exactRunMetadata?.containerId || !exactRunMetadata.deploymentLabels || !exactRunMetadata.imageId || !authority || !pending) throw handoffInputError();
      if (!recovered) await authority.observeDockerMutation(pending.pending_key, {
        containerId: exactRunMetadata.containerId, deploymentLabels: exactRunMetadata.deploymentLabels, imageId: exactRunMetadata.imageId
      });
      const finalized = await authority.finalize(pending.pending_key, { containerId: exactRunMetadata.containerId, deploymentLabels: exactRunMetadata.deploymentLabels });
      organizationHandoffHandle = finalized.organization_handoff_handle;
      const existingRecordPath = invocation.detach && invocation.deploymentName
        ? resolveDeploymentRecordPath(buildResult.outputDirectory, invocation.deploymentName)
        : null;
      if (existingRecordPath && await fileExists(existingRecordPath)) {
        const existing = await readDeploymentRecord(existingRecordPath);
        const target = await resolveDockerDeploymentTarget({
          context: invocation.dockerContext ?? undefined,
          dockerCommand: invocation.command,
          dockerHost: invocation.dockerHost ?? undefined,
          execFile: options.targetExecFile
        });
        const expected = createDockerDeploymentRecord({
          authProfileName: authProfile?.name ?? null,
          compileFingerprint: buildResult.report.compile_fingerprint ?? "",
          containerName: invocation.containerName,
          deploymentName: invocation.deploymentName ?? undefined,
          envFilePath: resolvedOptions.envFilePath,
          imageTag,
          networkIds: buildResult.report.container?.moltnet?.server_plans
            .filter((server) => server.mode === "managed").map((server) => server.network_id),
          nodes: buildResult.report.nodes,
          organizationHandoff: handoff.organizationHandoff,
          organizationHandoffHandle,
          outputDirectory: buildResult.outputDirectory,
          projectRoot: buildResult.report.root,
          runId: handoff.authority.runId,
          runMetadata: exactRunMetadata,
          runtimeInstanceIds: buildResult.report.container?.runtime_instances.map((instance) => instance.id) ?? [],
          target
        });
        if (canonicalJson(stableRecord(existing)) !== canonicalJson(stableRecord(expected))) throw handoffInputError();
        deploymentRecordPath = existingRecordPath;
      } else deploymentRecordPath = invocation.detach && invocation.deploymentName
        ? await writeDockerDeploymentRecordForRun({ authProfileName: authProfile?.name ?? null, envFilePath: resolvedOptions.envFilePath,
            imageTag, invocation, outputDirectory: buildResult.outputDirectory,
            organizationHandoff: handoff.organizationHandoff, organizationHandoffHandle, report: buildResult.report,
            runMetadata: exactRunMetadata, targetExecFile: options.targetExecFile })
        : null;
    } else deploymentRecordPath = invocation.detach && invocation.deploymentName
      ? await writeDockerDeploymentRecordForRun({ authProfileName: authProfile?.name ?? null, envFilePath: resolvedOptions.envFilePath,
          imageTag, invocation, outputDirectory: buildResult.outputDirectory, report: buildResult.report,
          runMetadata: runMetadata ?? undefined, targetExecFile: options.targetExecFile })
      : null;
  } finally {
    // Replay creates a fresh support directory but does not invoke the normal
    // Docker lifecycle wrapper. Preserve its detached credential cleanup
    // semantics without deleting bind-mount support files.
    let cleanupError: unknown;
    try {
      if (invocation.detach && !dockerLifecycleInvoked) await rm(invocation.envFilePath, { force: true });
    } catch (error) {
      cleanupError = error;
    }
    try {
      await authority?.dispose();
    } catch (error) {
      if (cleanupError === undefined) throw error;
    }
    if (cleanupError !== undefined) throw cleanupError;
  }

  if (deploymentRecordPath && buildResult.organizationReadinessEvidence) {
    const record = await readDeploymentRecord(deploymentRecordPath);
    const pending = createOrganizationReadinessPending(buildResult.organizationReadinessEvidence, {
      compileFingerprint: record.compile_fingerprint,
      deploymentName: record.name,
      runId: record.run_id ?? null,
      unitCount: record.units.length,
      unitId: record.units[0]?.id ?? "invalid-unit"
    });
    const pendingRecord = { ...record, organization_ready: pending };
    await writeDeploymentRecord(buildResult.outputDirectory, pendingRecord);
    const organizationReady = await probeDockerOrganizationReadiness({
      dockerCommand: options.dockerCommand,
      evidence: buildResult.organizationReadinessEvidence,
      execFile: options.targetExecFile,
      record: pendingRecord
    });
    await writeDeploymentRecord(buildResult.outputDirectory, {
      ...pendingRecord,
      organization_ready: organizationReady
    });
  }

  return {
    ...buildResult,
    authProfileName: authProfile?.name ?? null,
    containerName: invocation.containerName,
    deploymentRecordPath,
    imageTag,
    supportDirectory: invocation.supportDirectory
  };
};
