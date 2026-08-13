import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseRunId,
  type OpaqueTargetHandle
} from "./contracts.js";
import {
  createDockerResourceSpec,
  type DockerResourceSpec
} from "./dockerResourcesProvider.js";

export const ORGANIZATION_ATTACHMENT_ERROR = "Docker organization attachment failed";
export const ORGANIZATION_NETWORK_INSPECTION_FORMAT =
  "[{\"Id\":{{json .Id}},\"Name\":{{json .Name}},\"Labels\":{{json .Labels}},\"Internal\":{{json .Internal}}}]";
export const ORGANIZATION_EGRESS_NETWORK_INSPECTION_FORMAT =
  "[{\"Id\":{{json .Id}},\"Name\":{{json .Name}},\"Internal\":{{json .Internal}}}]";

/**
 * A semantic-only organization projection for the owner-side topology
 * attestor.  It neither returns nor accepts any discovered network name.
 */
export const organizationTopologyInspectionFormat = (networkName: string): string => {
  if (!/^spfn_[a-f0-9]{58}$/u.test(networkName)) return fail();
  const labels = DEPLOYMENT_LABEL_KEYS
    .map((key) => `${JSON.stringify(key)}:{{json (index .Config.Labels ${JSON.stringify(key)})}}`)
    .join(",");
  return `[{"Id":{{json .Id}},"Labels":{${labels}},"DataAttached":{{if index .NetworkSettings.Networks ${JSON.stringify(networkName)}}}true{{else}}false{{end}},"DataNetworkId":{{json (index .NetworkSettings.Networks ${JSON.stringify(networkName)}).NetworkID}},"NetworkAttachmentCount":{{len .NetworkSettings.Networks}},"NetworkMode":{{json .HostConfig.NetworkMode}},"EgressNetworkName":{{range $name, $network := .NetworkSettings.Networks}}{{if ne $name ${JSON.stringify(networkName)}}}{{json $name}}{{end}}{{end}},"EgressNetworkId":{{range $name, $network := .NetworkSettings.Networks}}{{if ne $name ${JSON.stringify(networkName)}}}{{json $network.NetworkID}}{{end}}{{end}}}]`;
};

const MAX_OUTPUT_BYTES = 32_768;
const DOCKER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DEPLOYMENT_LABEL_KEYS = Object.freeze([
  "com.spawnfile.compile_fingerprint",
  "com.spawnfile.deployment",
  "com.spawnfile.project",
  "com.spawnfile.run_id",
  "com.spawnfile.unit",
  "com.spawnfile.version"
] as const);

export interface DockerOrganizationAttachmentExecutor {
  (
    file: string,
    args: string[],
    options: { signal?: AbortSignal; timeout: number }
  ): Promise<{ stderr: string; stdout: string }>;
}

export type DockerOrganizationAttachmentFailureKind = "not_found";

export class DockerOrganizationAttachmentProviderError extends Error {
  public readonly kind: DockerOrganizationAttachmentFailureKind;
  public constructor(kind: DockerOrganizationAttachmentFailureKind) {
    super(ORGANIZATION_ATTACHMENT_ERROR);
    this.kind = kind;
  }
}

export type OrganizationDeploymentLabels = Readonly<Record<
  (typeof DEPLOYMENT_LABEL_KEYS)[number],
  string
>>;

export interface DockerOrganizationAttachmentSpec {
  readonly containerId: string;
  readonly containerInspectionFormat: string;
  readonly deploymentLabels: OrganizationDeploymentLabels;
  readonly network: DockerResourceSpec;
  readonly receiptLabels: Readonly<Record<string, string>>;
  readonly resultHandle: OpaqueTargetHandle;
}

const fail = (): never => { throw new Error(ORGANIZATION_ATTACHMENT_ERROR); };
const ordinary = (raw: unknown): void => {
  try { assertOrdinaryJsonGraph(raw); } catch { return fail(); }
};
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
};
const exactRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const digest = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-organization-attachment.${domain}.v1\0`, "utf8")
  .update(value, "utf8")
  .digest("hex");
const label = (prefix: string, value: string): string =>
  `${prefix}${digest("label", value).slice(0, 63)}`;

export const parseOrganizationContainerId = (raw: unknown): string => {
  if (typeof raw !== "string" || !DOCKER_ID_PATTERN.test(raw)) return fail();
  return raw;
};

export const parseOrganizationDeploymentLabels = (
  raw: unknown
): OrganizationDeploymentLabels => {
  ordinary(raw);
  if (!exactRecord(raw) || !exactKeys(raw, DEPLOYMENT_LABEL_KEYS)) return fail();
  for (const key of DEPLOYMENT_LABEL_KEYS) {
    if (typeof raw[key] !== "string" || !LABEL_VALUE_PATTERN.test(raw[key])) return fail();
  }
  return Object.freeze(Object.fromEntries(
    DEPLOYMENT_LABEL_KEYS.map((key) => [key, raw[key]])
  )) as OrganizationDeploymentLabels;
};

const containerInspectionFormat = (networkName: string): string => {
  const labels = DEPLOYMENT_LABEL_KEYS
    .map((key) => `${JSON.stringify(key)}:{{json (index .Config.Labels ${JSON.stringify(key)})}}`)
    .join(",");
  return `[{"Id":{{json .Id}},"Labels":{${labels}},"Attached":{{if index .NetworkSettings.Networks ${JSON.stringify(networkName)}}}true{{else}}false{{end}}}]`;
};

export const createDockerOrganizationAttachmentSpec = (input: {
  readonly containerId: unknown;
  readonly dataNetworkOperationHandle: OpaqueTargetHandle;
  readonly dataNetworkRequestDigest: string;
  readonly deploymentLabels: unknown;
  readonly operationHandle: OpaqueTargetHandle;
  readonly organizationHandoffHandle: OpaqueTargetHandle;
  readonly requestDigest: string;
  readonly runId: string;
  readonly selectedTargetHandle: OpaqueTargetHandle;
}): DockerOrganizationAttachmentSpec => {
  const containerId = parseOrganizationContainerId(input.containerId);
  const deploymentLabels = parseOrganizationDeploymentLabels(input.deploymentLabels);
  const organizationHandoffHandle = parseOpaqueTargetHandle(input.organizationHandoffHandle);
  const operationHandle = parseOpaqueTargetHandle(input.operationHandle);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.requestDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.dataNetworkRequestDigest)) return fail();
  const runId = parseRunId(input.runId);
  const selectedTargetHandle = parseOpaqueTargetHandle(input.selectedTargetHandle);
  const network = createDockerResourceSpec({
    kind: "data_network",
    operationHandle: parseOpaqueTargetHandle(input.dataNetworkOperationHandle),
    requestDigest: input.dataNetworkRequestDigest,
    runId,
    selectedTargetHandle
  });
  const authority = `${operationHandle}\0${input.requestDigest}\0${organizationHandoffHandle}\0${network.resultHandle}`;
  const receiptLabels = Object.freeze({
    spawnfile_attachment_v1_handoff: label("h", organizationHandoffHandle),
    spawnfile_attachment_v1_kind: "organization_attachment",
    spawnfile_attachment_v1_network: label("n", network.resultHandle),
    spawnfile_attachment_v1_operation: label("o", `${operationHandle}\0${input.requestDigest}`),
    spawnfile_attachment_v1_target: label("t", selectedTargetHandle),
    spawnfile_attachment_v1_version: "v1"
  });
  return Object.freeze({
    containerId,
    containerInspectionFormat: containerInspectionFormat(network.name),
    deploymentLabels,
    network,
    receiptLabels,
    resultHandle: parseOpaqueTargetHandle(`opaque_${digest("result", authority)}`)
  });
};

const isUtf8 = (value: string): boolean =>
  Buffer.from(value, "utf8").toString("utf8") === value;
const boundedText = (value: unknown): value is string =>
  typeof value === "string" && isUtf8(value) && bytes(value) <= MAX_OUTPUT_BYTES;

export const executeDockerOrganizationAttachment = async (input: {
  readonly args: string[];
  readonly executor: DockerOrganizationAttachmentExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<{ stderr: string; stdout: string }> => {
  try {
    const result = await input.executor("docker", input.args, {
      signal: input.signal,
      timeout: input.timeoutMs
    });
    if (!result || !boundedText(result.stdout) || !boundedText(result.stderr)) return fail();
    return result;
  } catch (error) {
    if (error instanceof DockerOrganizationAttachmentProviderError) throw error;
    return fail();
  }
};

const skipWhitespace = (source: string, index: number): number => {
  while (index < source.length && /[\t\n\r ]/u.test(source[index]!)) index += 1;
  return index;
};
const stringEnd = (source: string, start: number): number => {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") { index += 2; continue; }
    if (source[index] === "\"") return index + 1;
    index += 1;
  }
  return fail();
};
const duplicateFreeValue = (source: string, start: number): number => {
  let index = skipWhitespace(source, start); const token = source[index];
  if (token === "\"") return stringEnd(source, index);
  if (token === "{") {
    index = skipWhitespace(source, index + 1); const keys = new Set<string>();
    if (source[index] === "}") return index + 1;
    while (true) {
      if (source[index] !== "\"") return fail();
      const end = stringEnd(source, index); const key = JSON.parse(source.slice(index, end)) as string;
      if (keys.has(key)) return fail(); keys.add(key); index = skipWhitespace(source, end);
      if (source[index] !== ":") return fail();
      index = duplicateFreeValue(source, index + 1); index = skipWhitespace(source, index);
      if (source[index] === "}") return index + 1;
      if (source[index] !== ",") return fail(); index = skipWhitespace(source, index + 1);
    }
  }
  if (token === "[") {
    index = skipWhitespace(source, index + 1);
    if (source[index] === "]") return index + 1;
    while (true) {
      index = duplicateFreeValue(source, index); index = skipWhitespace(source, index);
      if (source[index] === "]") return index + 1;
      if (source[index] !== ",") return fail(); index = skipWhitespace(source, index + 1);
    }
  }
  while (index < source.length && !/[\t\n\r ,}\]]/u.test(source[index]!)) index += 1;
  if (index === start) return fail(); return index;
};

const parseProjection = (stdout: string): Record<string, unknown> | null => {
  try {
    if (!boundedText(stdout)) return null;
    const end = duplicateFreeValue(stdout, 0);
    if (skipWhitespace(stdout, end) !== stdout.length) return null;
    const raw: unknown = JSON.parse(stdout);
    assertOrdinaryJsonGraph(raw);
    if (!Array.isArray(raw) || raw.length !== 1 || !exactRecord(raw[0])) return null;
    return raw[0];
  } catch {
    return null;
  }
};

export const parseExpectedOrganizationNetwork = (
  stdout: string,
  spec: DockerOrganizationAttachmentSpec
): string | null => {
  const record = parseProjection(stdout);
  if (!record || !exactKeys(record, ["Id", "Internal", "Labels", "Name"])
    || record.Name !== spec.network.name || record.Internal !== true
    || !exactRecord(record.Labels)) {
    return null;
  }
  const labels = record.Labels;
  if (!exactKeys(labels, Object.keys(spec.network.labels))
    || Object.entries(spec.network.labels).some(([key, value]) => labels[key] !== value)) {
    return null;
  }
  try { return parseOrganizationContainerId(record.Id); } catch { return null; }
};

export const parseExpectedOrganizationContainer = (
  stdout: string,
  spec: DockerOrganizationAttachmentSpec
): { readonly attached: boolean } | null => {
  const record = parseProjection(stdout);
  if (!record || !exactKeys(record, ["Attached", "Id", "Labels"])
    || record.Id !== spec.containerId || typeof record.Attached !== "boolean") return null;
  try {
    const labels = parseOrganizationDeploymentLabels(record.Labels);
    if (DEPLOYMENT_LABEL_KEYS.some((key) => labels[key] !== spec.deploymentLabels[key])) return null;
    return Object.freeze({ attached: record.Attached });
  } catch {
    return null;
  }
};

/**
 * The attached organization keeps exactly its owner-managed egress attachment
 * plus the target-owned private data attachment.  This is intentionally a
 * boolean validator so private Docker names cannot escape the provider layer.
 */
export const parseExpectedOrganizationEgressNetwork = (
  stdout: string,
  spec: DockerOrganizationAttachmentSpec
): { readonly dataNetworkId: string; readonly id: string; readonly name: string } | null => {
  const record = parseProjection(stdout);
  if (!record || !exactKeys(record, ["DataAttached", "DataNetworkId", "EgressNetworkId", "EgressNetworkName", "Id", "Labels", "NetworkAttachmentCount", "NetworkMode"])
    || record.Id !== spec.containerId || record.DataAttached !== true
    || record.NetworkAttachmentCount !== 2 || typeof record.EgressNetworkName !== "string"
    || typeof record.EgressNetworkId !== "string"
    || typeof record.DataNetworkId !== "string"
    || typeof record.NetworkMode !== "string" || record.NetworkMode === "host"
    || record.NetworkMode === "none" || record.NetworkMode.startsWith("container:")
    || record.EgressNetworkName === spec.network.name
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u.test(record.EgressNetworkName)) return null;
  try {
    const labels = parseOrganizationDeploymentLabels(record.Labels);
    return DEPLOYMENT_LABEL_KEYS.every((key) => labels[key] === spec.deploymentLabels[key])
      ? Object.freeze({
        dataNetworkId: parseOrganizationContainerId(record.DataNetworkId),
        id: parseOrganizationContainerId(record.EgressNetworkId),
        name: record.EgressNetworkName
      }) : null;
  } catch {
    return null;
  }
};

/** Validates exactly one owner-managed non-internal egress network by name. */
export const isExpectedOrganizationEgressNetwork = (
  stdout: string,
  expected: { readonly id: string; readonly name: string }
): boolean => {
  const record = parseProjection(stdout);
  return Boolean(record && exactKeys(record, ["Id", "Internal", "Name"])
    && record.Id === expected.id && record.Name === expected.name && record.Internal === false);
};
