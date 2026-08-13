import { SpawnfileError } from "../shared/index.js";
import {
  type OpaqueTargetHandle,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import { selectTarget } from "./dockerTarget.js";
import { createTargetReceiptDigest } from "./handles.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";
import {
  createDockerResourceSpec,
  executeDockerResource,
  isExpectedDockerResource,
  type DockerResourceKind
} from "./dockerResourcesProvider.js";
import {
  createExistingDockerSecretSpec,
  executeDockerSecretCommand,
  isExpectedDockerSecretVolume
} from "./dockerSecretsProvider.js";
import {
  WORLD_SERVICE_ERROR,
  createWorldServiceAuthorization,
  parseWorldServiceResolution,
  type WorldServiceResolution,
  type WorldServiceResolver
} from "./dockerWorldServiceAuthority.js";
import {
  DockerWorldServiceProviderError,
  createDockerWorldServiceSpec,
  executeDockerWorldService,
  parseExpectedDockerWorldService,
  type DockerWorldServiceExecutor,
  type DockerWorldServiceInspection,
  type DockerWorldServiceSpec
} from "./dockerWorldServiceProvider.js";
import {
  parseWorldServiceBinding,
  worldServiceResourceBindings,
  type WorldServiceAuthorityStore,
  type WorldServiceBinding
} from "./dockerWorldServiceStore.js";

type ServiceRequest = Extract<TargetResourceRequest, {
  operation: "create_world_service" | "start_world_service" | "stop_world_service";
}>;
type CreateRequest = Extract<ServiceRequest, { operation: "create_world_service" }>;

export interface WorldServiceCleanupContext {
  readonly context: string;
  readonly executor: DockerWorldServiceExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface WorldServiceLifecycleContext extends WorldServiceCleanupContext {
  readonly authorityStore: WorldServiceAuthorityStore;
  readonly journal: TargetJournalStore;
  readonly resolver: WorldServiceResolver;
}

const fail = (): never => {
  throw new SpawnfileError("runtime_error", WORLD_SERVICE_ERROR);
};
export const sameWorldServiceValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const selectedWorldServiceContextMatches = async (
  request: ServiceRequest,
  options: WorldServiceLifecycleContext
): Promise<void> => {
  const selected = await selectTarget({
    context: options.context,
    dockerCommand: "docker",
    execFile: async (_file, args, commandOptions) => executeDockerWorldService({
      args,
      executor: options.executor,
      signal: commandOptions.signal,
      timeoutMs: commandOptions.timeout
    }),
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  if (!sameWorldServiceValue({ fingerprint: selected.fingerprint, handle: selected.handle },
    request.selected_target)) return fail();
};

const findResourceClaim = async (input: {
  readonly handle: OpaqueTargetHandle;
  readonly journal: TargetJournalStore;
  readonly kind: DockerResourceKind;
  readonly runId: string;
  readonly selectedTargetHandle: OpaqueTargetHandle;
}): Promise<TargetJournalClaim> => {
  const operation = input.kind === "data_network"
    ? "create_data_network" : "create_evidence_volume";
  const journal = await input.journal.read();
  const matches = journal.entries.filter((entry) => {
    if (entry.operation !== operation || entry.state !== "completed") return false;
    try {
      return createDockerResourceSpec({
        kind: input.kind,
        operationHandle: entry.operation_handle,
        requestDigest: entry.request_digest,
        runId: input.runId,
        selectedTargetHandle: input.selectedTargetHandle
      }).resultHandle === input.handle;
    } catch { return false; }
  });
  if (matches.length !== 1) return fail();
  return {
    operationHandle: matches[0]!.operation_handle,
    requestDigest: matches[0]!.request_digest as TargetJournalClaim["requestDigest"]
  };
};

export const resolveWorldServiceCreate = async (
  request: CreateRequest,
  claim: TargetJournalClaim,
  options: WorldServiceLifecycleContext
): Promise<{ readonly resolution: WorldServiceResolution;
  readonly resources: WorldServiceBinding["resources"] }> => {
  const authorization = createWorldServiceAuthorization({
    dataNetworkHandle: request.data_network_handle,
    descriptorDigest: request.descriptor_digest,
    evidenceMountPath: request.evidence_mount_path,
    evidenceVolumeHandle: request.evidence_volume_handle,
    operationHandle: claim.operationHandle,
    requestDigest: claim.requestDigest,
    runId: request.run_id,
    secretBindingsHandle: request.secret_bindings_handle,
    selectedTarget: request.selected_target,
    worldArtifactHandle: request.world_artifact_handle
  });
  const resolution = parseWorldServiceResolution(await options.resolver.resolve({
    authorization,
    signal: options.signal
  }));
  if (!sameWorldServiceValue(resolution.authorization, authorization)) return fail();
  const journal = await options.journal.read();
  const artifactClaims = journal.entries.filter((entry) =>
    entry.operation === "resolve_world_artifact" && entry.state === "completed"
    && entry.operation_handle === resolution.artifact.operation_handle
    && entry.request_digest === resolution.artifact.request_digest);
  if (artifactClaims.length !== 1) return fail();
  const dataNetworkClaim = await findResourceClaim({
    handle: request.data_network_handle,
    journal: options.journal,
    kind: "data_network",
    runId: request.run_id,
    selectedTargetHandle: request.selected_target.handle
  });
  const evidenceVolumeClaim = await findResourceClaim({
    handle: request.evidence_volume_handle,
    journal: options.journal,
    kind: "evidence_volume",
    runId: request.run_id,
    selectedTargetHandle: request.selected_target.handle
  });
  const resources = worldServiceResourceBindings({
    dataNetworkClaim,
    evidenceVolumeClaim,
    resolution
  });
  await options.authorityStore.bindResolution(resolution);
  return { resolution, resources };
};

export const verifyWorldServiceResources = async (
  binding: Pick<WorldServiceBinding, "resolution" | "resources">,
  options: WorldServiceLifecycleContext
): Promise<void> => {
  const authorization = binding.resolution.authorization;
  for (const [kind, resource] of [
    ["data_network", binding.resources.data_network],
    ["evidence_volume", binding.resources.evidence_volume]
  ] as const) {
    const claim = await findResourceClaim({
      handle: resource.handle,
      journal: options.journal,
      kind,
      runId: authorization.run_id,
      selectedTargetHandle: authorization.selected_target.handle
    });
    const spec = createDockerResourceSpec({
      kind,
      ...claim,
      runId: authorization.run_id,
      selectedTargetHandle: authorization.selected_target.handle
    });
    const result = await executeDockerResource({
      args: ["--context", options.context,
        kind === "data_network" ? "network" : "volume", "inspect",
        "--format", spec.inspectionFormat, spec.name],
      executor: options.executor,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    });
    if (!isExpectedDockerResource(result.stdout, spec)) return fail();
  }
  const secretSpec = createExistingDockerSecretSpec({
    bindingsHandle: binding.resources.secret_bindings.handle,
    runId: authorization.run_id,
    selectedTargetHandle: authorization.selected_target.handle
  });
  const secret = await executeDockerSecretCommand({
    args: ["--context", options.context, "volume", "inspect", "--format",
      secretSpec.volumeInspectionFormat, secretSpec.volumeName],
    executor: options.executor,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  if (!isExpectedDockerSecretVolume(secret.stdout, secretSpec)) return fail();
};

export const worldServiceSpecForBinding = (binding: Pick<WorldServiceBinding,
  "resolution" | "resources">): DockerWorldServiceSpec => {
  const authorization = binding.resolution.authorization;
  return createDockerWorldServiceSpec({
    dataNetwork: binding.resources.data_network,
    evidenceMountPath: authorization.evidence_mount_path,
    evidenceVolume: binding.resources.evidence_volume,
    imageDigest: binding.resolution.artifact.image_digest,
    imageReference: binding.resolution.artifact.image_reference,
    operationHandle: authorization.operation_handle,
    requestDigest: authorization.request_digest,
    runId: authorization.run_id,
    secretBindings: binding.resources.secret_bindings,
    selectedTargetHandle: authorization.selected_target.handle,
    ...(binding.resolution.artifact.identity_kind === "docker_image_config_digest"
      ? { networkAlias: binding.resolution.artifact.network_alias } : {})
  });
};

export const inspectDockerWorldService = async (
  reference: string,
  spec: DockerWorldServiceSpec,
  options: WorldServiceCleanupContext
): Promise<DockerWorldServiceInspection | null> => {
  try {
    const result = await executeDockerWorldService({
      args: ["--context", options.context, "container", "inspect", "--format",
        spec.inspectionFormat, reference],
      executor: options.executor,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    });
    return parseExpectedDockerWorldService(result.stdout, spec) ?? fail();
  } catch (error) {
    if (error instanceof DockerWorldServiceProviderError && error.kind === "not_found") {
      return null;
    }
    throw error;
  }
};

export const mutateDockerWorldService = async (
  args: string[],
  options: WorldServiceCleanupContext
): Promise<string> => {
  const result = await executeDockerWorldService({
    args: ["--context", options.context, ...args],
    executor: options.executor,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  if (result.stderr !== "") return fail();
  return result.stdout;
};

const activeWorldStatus = (
  status: DockerWorldServiceInspection["status"]
): boolean => status === "running" || status === "paused" || status === "restarting";
const exactWorldAck = (value: string, containerId: string): boolean =>
  value === `${containerId}\n`;
const inspectedWorld = async (
  binding: WorldServiceBinding,
  spec: DockerWorldServiceSpec,
  options: WorldServiceCleanupContext
): Promise<DockerWorldServiceInspection | null> => {
  const current = await inspectDockerWorldService(binding.container_id, spec, options);
  if (current && current.containerId !== binding.container_id) return fail();
  return current;
};

export const removeExactDockerWorldService = async (
  rawBinding: unknown,
  options: WorldServiceCleanupContext
): Promise<void> => {
  try {
    if (!options || typeof options.context !== "string"
      || !/^[a-z][a-z0-9_-]{0,63}$/u.test(options.context)
      || typeof options.executor !== "function" || !Number.isSafeInteger(options.timeoutMs)
      || options.timeoutMs < 1 || options.timeoutMs > 120_000) return fail();
    const binding = parseWorldServiceBinding(rawBinding);
    const spec = worldServiceSpecForBinding(binding);
    if (spec.resultHandle !== binding.world_service_handle) return fail();
    let current = await inspectedWorld(binding, spec, options);
    if (current === null) return;
    if (current.status === "removing") return fail();
    if (activeWorldStatus(current.status)) {
      let stopError: unknown;
      let stopAck: string | undefined;
      try {
        stopAck = await mutateDockerWorldService(
          ["container", "stop", "--timeout", "10", binding.container_id],
          options
        );
      } catch (error) { stopError = error; }
      if (stopAck !== undefined && !exactWorldAck(stopAck, binding.container_id)) return fail();
      current = await inspectedWorld(binding, spec, options);
      if (current === null) return;
      if (activeWorldStatus(current.status) || current.status === "removing") {
        if (stopError) throw stopError;
        return fail();
      }
    }
    let removeError: unknown;
    let removeAck: string | undefined;
    try {
      removeAck = await mutateDockerWorldService(
        ["container", "rm", binding.container_id],
        options
      );
    } catch (error) { removeError = error; }
    if (removeAck !== undefined && !exactWorldAck(removeAck, binding.container_id)) return fail();
    if (await inspectedWorld(binding, spec, options) !== null) {
      if (removeError) throw removeError;
      return fail();
    }
  } catch { return fail(); }
};

export const createWorldServiceReceipt = async (input: {
  readonly claim: TargetJournalClaim;
  readonly journal: TargetJournalStore;
  readonly labels: Readonly<Record<string, string>>;
  readonly request: ServiceRequest;
  readonly resultHandle: OpaqueTargetHandle | null;
}): Promise<TargetResourceReceipt> => {
  const raw = {
    cleanup_state: "not_requested",
    descriptor_digest: input.request.descriptor_digest,
    export_state: "not_requested",
    labels: Object.entries(input.labels).map(([key, value]) => ({ key, value })),
    operation: input.request.operation,
    operation_handle: input.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: input.claim.requestDigest,
    result_handle: input.resultHandle,
    resulting_revision: (await input.journal.read()).revision + 1,
    run_id: input.request.run_id,
    selected_target: input.request.selected_target,
    version: "spawnfile.target-resource.receipt.v1"
  } as const;
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) };
};
