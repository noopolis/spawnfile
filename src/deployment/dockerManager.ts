import path from "node:path";

import { normalizeProjectLabelSlug } from "../distribution/index.js";
import { resolveNoopolisRunId } from "../runtime/index.js";
import type { DeploymentRecordSource } from "./record.js";
import { SpawnfileError } from "../shared/index.js";
import type { OrganizationReadinessEvidence } from "../compiler/organizationReadyEvidence.js";

import { inspectDockerDeployment } from "./dockerInspect.js";
import { normalizeDeploymentName } from "./names.js";
import { createDockerProbeGateway, type DockerProbeExecFile } from "./dockerProbeGateway.js";
import {
  organizationReadinessFromProbeError,
  reconcileOrganizationReadiness,
  type OrganizationReadiness
} from "./organizationReady.js";
import {
  resolveDockerDeploymentTarget,
  type DockerDeploymentTarget,
  type DockerTargetExecFile
} from "./target.js";
import { writeDeploymentRecord, type DeploymentRecord } from "./record.js";
import {
  createOrganizationHandoff,
  type OrganizationHandoff,
  type OrganizationHandoffInput
} from "./organizationHandoffTypes.js";
import type { OpaqueTargetHandle, SelectedTargetReceipt } from "../target/index.js";

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
    moltnet?: {
      server_plans: Array<{
        mode: "external" | "managed";
        network_id: string;
      }>;
    };
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
  networkIds?: string[];
  nodes: DockerDeploymentNodeInput[];
  outputDirectory: string;
  organizationHandoff?: OrganizationHandoffInput;
  organizationHandoffHandle?: OpaqueTargetHandle;
  projectRoot: string;
  runId?: string;
  runMetadata?: DockerDeploymentRunMetadata;
  runtimeInstanceIds: string[];
  source?: DeploymentRecordSource;
  target: DockerDeploymentTarget;
}

export const createDockerOrganizationHandoffSession = (input: {
  readonly bindingDigest: string;
  readonly containerName: string;
  readonly deploymentLabels: Readonly<Record<string, string>>;
  readonly descriptorDigest: string;
  readonly organizationHandoff: OrganizationHandoffInput;
  readonly runId: string;
  readonly selectedTarget: SelectedTargetReceipt;
  readonly selectedTargetReceiptDigest: string;
}): {
  readonly authorityInput: {
    readonly bindingDigest: string;
    readonly containerName: string;
    readonly deploymentLabels: Readonly<Record<string, string>>;
    readonly descriptorDigest: string;
    readonly handoff: OrganizationHandoff;
    readonly selectedTarget: SelectedTargetReceipt;
    readonly selectedTargetReceiptDigest: string;
  };
  readonly organizationHandoff: OrganizationHandoff;
} => {
  const organizationHandoff = createOrganizationHandoff(input.runId, input.organizationHandoff);
  return Object.freeze({
    authorityInput: Object.freeze({
      bindingDigest: input.bindingDigest,
      containerName: input.containerName,
      deploymentLabels: input.deploymentLabels,
      descriptorDigest: input.descriptorDigest,
      handoff: organizationHandoff,
      selectedTarget: input.selectedTarget,
      selectedTargetReceiptDigest: input.selectedTargetReceiptDigest
    }),
    organizationHandoff
  });
};

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
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(input.runId && input.organizationHandoff
      ? { organization_handoff: createOrganizationHandoff(input.runId, input.organizationHandoff) }
      : {}),
    ...(input.runId && input.organizationHandoff && input.organizationHandoffHandle
      ? { organization_handoff_handle: input.organizationHandoffHandle }
      : {}),
    source: input.source ?? { kind: "project", root: path.resolve(input.projectRoot) },
    target: input.target,
    units: [
      {
        container_id: input.runMetadata?.containerId ?? null,
        container_name: input.containerName,
        contains: [
          ...input.nodes.map((node) => ({ id: node.id, kind: node.kind })),
          ...[...new Set(input.networkIds ?? [])]
            .sort()
            .map((id) => ({ id, kind: "network" as const }))
        ],
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
  organizationHandoff?: OrganizationHandoffInput;
  organizationHandoffHandle?: OpaqueTargetHandle;
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
    networkIds: input.report.container?.moltnet?.server_plans
      .filter((server) => server.mode === "managed")
      .map((server) => server.network_id),
    nodes: input.report.nodes,
    outputDirectory: input.outputDirectory,
    ...(input.organizationHandoff ? { organizationHandoff: input.organizationHandoff } : {}),
    ...(input.organizationHandoffHandle ? { organizationHandoffHandle: input.organizationHandoffHandle } : {}),
    projectRoot: input.report.root,
    // Sourced from the host process env at record-write time, not the
    // compile report: `spawnfile run`/`up --detach` always call
    // ensureNoopolisRunId() before compiling (src/compiler/CLAUDE.md), so by
    // the time this record is written the run id — if any — is already on
    // process.env. A bare host env with no run id yields no `run_id` field.
    runId: resolveNoopolisRunId(process.env),
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

export interface ProbeDockerOrganizationReadinessInput {
  dockerCommand?: string;
  evidence: OrganizationReadinessEvidence;
  execFile?: DockerProbeExecFile;
  record: DeploymentRecord;
  timeoutMs?: number;
}

const recordCorrelation = (record: DeploymentRecord) => ({
  compileFingerprint: record.compile_fingerprint,
  deploymentName: record.name,
  runId: record.run_id ?? null,
  unitCount: record.units.length,
  unitId: record.units[0]?.id ?? "invalid-unit"
});

/**
 * Performs the single manager-owned inspection, public health checks, and
 * bounded artifact reads needed to reconcile immutable compiler evidence.
 * It deliberately returns a safe value only; upProject owns both persistence writes.
 */
export const probeDockerOrganizationReadiness = async (
  input: ProbeDockerOrganizationReadinessInput
): Promise<OrganizationReadiness> => {
  const correlation = recordCorrelation(input.record);
  try {
    const inspections = await inspectDockerDeployment(input.record, {
      dockerCommand: input.dockerCommand,
      execFile: input.execFile,
      timeoutMs: input.timeoutMs
    });
    const unit = input.record.units[0];
    const inspected = unit ? inspections.get(unit.id) ?? null : null;
    if (!unit || !inspected) {
      return reconcileOrganizationReadiness({
        evidence: input.evidence, inspection: null, probe: null, record: correlation
      });
    }
    const gateway = createDockerProbeGateway(input.record, unit, {
      dockerCommand: input.dockerCommand,
      execFile: input.execFile,
      inspection: inspected,
      timeoutMs: input.timeoutMs
    });
    const inspection = await gateway.inspectUnit();
    if (input.evidence.hasExternalMoltnet || !input.evidence.worldBindings) {
      return reconcileOrganizationReadiness({
        evidence: input.evidence, inspection, probe: null, record: correlation
      });
    }
    const networks = [] as Array<{
      healthOk: boolean;
      id: string;
    }>;
    for (const network of input.evidence.networks) {
      if (network.mode !== "managed" || network.internalPort === null) {
        return reconcileOrganizationReadiness({
          evidence: input.evidence, inspection, probe: null, record: correlation
        });
      }
      const health = await gateway.httpGet(network.internalPort, "/healthz");
      if (!health.ok) {
        return organizationReadinessFromProbeError(
          input.evidence,
          correlation,
          new Error(health.error ?? "probe unavailable")
        );
      }
      networks.push({
        healthOk: health.ok,
        id: network.id
      });
    }
    const configs = new Map<string, string>();
    for (const network of input.evidence.networks) {
      for (const node of network.nodes) {
        const result = await gateway.exec(["cat", node.configPath]);
        configs.set(node.configPath, result.stdout);
      }
    }
    const bindings = await gateway.exec(["cat", input.evidence.worldBindings.artifactPath]);
    return reconcileOrganizationReadiness({
      evidence: input.evidence,
      inspection,
      probe: { configs, networks, worldBindings: bindings.stdout },
      record: correlation
    });
  } catch (error) {
    return organizationReadinessFromProbeError(input.evidence, correlation, error);
  }
};
