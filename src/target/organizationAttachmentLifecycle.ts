import { SpawnfileError } from "../shared/index.js";
import {
  ORGANIZATION_ATTACHMENT_ERROR,
  ORGANIZATION_NETWORK_INSPECTION_FORMAT,
  DockerOrganizationAttachmentProviderError,
  createDockerOrganizationAttachmentSpec,
  executeDockerOrganizationAttachment,
  parseExpectedOrganizationContainer,
  parseExpectedOrganizationNetwork,
  type DockerOrganizationAttachmentExecutor,
  type DockerOrganizationAttachmentSpec
} from "./organizationAttachmentProvider.js";
import {
  parseOrganizationAttachmentBinding,
  type OrganizationAttachmentBinding
} from "./organizationAttachmentStore.js";

export interface OrganizationAttachmentLifecycleOptions {
  readonly context: string;
  readonly executor: DockerOrganizationAttachmentExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

const fail = (): never => {
  throw new SpawnfileError("runtime_error", ORGANIZATION_ATTACHMENT_ERROR);
};

const validOptions = (
  raw: OrganizationAttachmentLifecycleOptions
): OrganizationAttachmentLifecycleOptions => {
  if (!raw || typeof raw.context !== "string" || !CONTEXT_PATTERN.test(raw.context)
    || typeof raw.executor !== "function" || typeof raw.timeoutMs !== "number"
    || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1
    || raw.timeoutMs > 120_000) return fail();
  return raw;
};

export const executeOrganizationAttachmentCommand = async (
  args: string[],
  options: OrganizationAttachmentLifecycleOptions
): Promise<{ stderr: string; stdout: string }> =>
  executeDockerOrganizationAttachment({
    args,
    executor: options.executor,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });

export const inspectNetwork = async (
  spec: DockerOrganizationAttachmentSpec,
  options: OrganizationAttachmentLifecycleOptions
): Promise<string> => {
  const result = await executeOrganizationAttachmentCommand([
    "--context", options.context, "network", "inspect", "--format",
    ORGANIZATION_NETWORK_INSPECTION_FORMAT, spec.network.name
  ], options);
  const id = parseExpectedOrganizationNetwork(result.stdout, spec);
  if (result.stderr !== "" || id === null) return fail();
  return id;
};

export const inspectContainer = async (
  spec: DockerOrganizationAttachmentSpec,
  options: OrganizationAttachmentLifecycleOptions
): Promise<{ readonly attached: boolean }> => {
  const result = await executeOrganizationAttachmentCommand([
    "--context", options.context, "container", "inspect", "--format",
    spec.containerInspectionFormat, spec.containerId
  ], options);
  const inspection = parseExpectedOrganizationContainer(result.stdout, spec);
  if (result.stderr !== "" || inspection === null) return fail();
  return inspection;
};

const networkMutation = (
  operation: "connect" | "disconnect",
  networkId: string,
  containerId: string,
  options: OrganizationAttachmentLifecycleOptions
): Promise<{ stderr: string; stdout: string }> => executeOrganizationAttachmentCommand([
  "--context", options.context, "network", operation, networkId, containerId
], options);

export const mutate = async (
  operation: "connect" | "disconnect",
  networkId: string,
  containerId: string,
  options: OrganizationAttachmentLifecycleOptions
): Promise<void> => {
  const result = await networkMutation(operation, networkId, containerId, options);
  if (result.stdout !== "" || result.stderr !== "") return fail();
};

const specFor = (
  binding: OrganizationAttachmentBinding
): DockerOrganizationAttachmentSpec => createDockerOrganizationAttachmentSpec({
  containerId: binding.resolution.network_attachment.container_id,
  dataNetworkOperationHandle: binding.data_network.operation_handle,
  dataNetworkRequestDigest: binding.data_network.request_digest,
  deploymentLabels: binding.resolution.network_attachment.deployment_labels,
  operationHandle: binding.resolution.authorization.operation_handle,
  organizationHandoffHandle:
    binding.resolution.authorization.organization_handoff_handle,
  requestDigest: binding.resolution.authorization.request_digest,
  runId: binding.resolution.authorization.run_id,
  selectedTargetHandle: binding.resolution.authorization.selected_target.handle
});

const inspectContainerOrAbsent = async (
  spec: DockerOrganizationAttachmentSpec,
  options: OrganizationAttachmentLifecycleOptions
): Promise<{ readonly attached: boolean } | null> => {
  try {
    return await inspectContainer(spec, options);
  } catch (error) {
    if (error instanceof DockerOrganizationAttachmentProviderError
      && error.kind === "not_found") return null;
    throw error;
  }
};

const proveNetwork = async (
  binding: OrganizationAttachmentBinding,
  spec: DockerOrganizationAttachmentSpec,
  options: OrganizationAttachmentLifecycleOptions
): Promise<void> => {
  if (await inspectNetwork(spec, options) !== binding.data_network.id) return fail();
};

export const detachExactOrganizationAttachment = async (
  rawBinding: unknown,
  options: OrganizationAttachmentLifecycleOptions
): Promise<void> => {
  // Parse the complete immutable authority record before any provider call.
  const binding = parseOrganizationAttachmentBinding(rawBinding);
  const checkedOptions = validOptions(options);
  const spec = specFor(binding);
  if (spec.resultHandle !== binding.attachment_handle) return fail();

  await proveNetwork(binding, spec, checkedOptions);
  const before = await inspectContainerOrAbsent(spec, checkedOptions);
  if (before === null || !before.attached) return;

  let mutationResult: { stderr: string; stdout: string } | undefined;
  try {
    mutationResult = await networkMutation(
      "disconnect", binding.data_network.id, spec.containerId, checkedOptions
    );
  } catch {
    // A thrown mutation is ambiguous. Reconciliation below is the only retry-like action.
  }
  if (mutationResult
    && (mutationResult.stdout !== "" || mutationResult.stderr !== "")) return fail();

  const after = await inspectContainerOrAbsent(spec, checkedOptions);
  if (after?.attached === true) return fail();
  await proveNetwork(binding, spec, checkedOptions);
};
