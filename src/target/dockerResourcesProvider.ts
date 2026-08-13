import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { assertOrdinaryJsonGraph, parseOpaqueTargetHandle, type OpaqueTargetHandle } from "./contracts.js";

export const DOCKER_RESOURCE_ERROR = "Docker resource mutation failed";
const MAX_OUTPUT_BYTES = 32_768;
const MAX_NAME_LENGTH = 63;

export type DockerResourceKind = "data_network" | "evidence_volume";
export type DockerResourceFailureKind = "collision" | "not_found";

export interface DockerResourceExecutor {
  (file: string, args: string[], options: { signal?: AbortSignal; timeout: number }): Promise<{ stderr: string; stdout: string }>;
}

/** A safe error classification supplied by the injected provider bridge. */
export class DockerResourceProviderError extends Error {
  public readonly kind: DockerResourceFailureKind;
  public constructor(kind: DockerResourceFailureKind) { super(DOCKER_RESOURCE_ERROR); this.kind = kind; }
}

export interface DockerResourceSpec {
  readonly args: string[];
  readonly inspectionFormat: string;
  readonly kind: DockerResourceKind;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly resultHandle: OpaqueTargetHandle;
}

export const isCanonicalDockerResourceSpec = (raw: unknown): raw is DockerResourceSpec => {
  try { assertOrdinaryJsonGraph(raw); } catch { return false; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return false;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join("\0")
    !== "args\0inspectionFormat\0kind\0labels\0name\0resultHandle"
    || value.kind !== "data_network" && value.kind !== "evidence_volume"
    || typeof value.name !== "string"
    || !(value.kind === "data_network" ? /^spfn_[a-f0-9]{58}$/u : /^spfv_[a-f0-9]{58}$/u)
      .test(value.name)
    || !value.labels || typeof value.labels !== "object" || Array.isArray(value.labels)
    || Object.getPrototypeOf(value.labels) !== Object.prototype) return false;
  const labels = value.labels as Record<string, unknown>;
  const labelKeys = [
    "spawnfile_resource_v1_kind", "spawnfile_resource_v1_operation",
    "spawnfile_resource_v1_run", "spawnfile_resource_v1_target",
    "spawnfile_resource_v1_version"
  ];
  if (Object.keys(labels).sort().join("\0") !== [...labelKeys].sort().join("\0")
    || labels.spawnfile_resource_v1_kind !== value.kind
    || typeof labels.spawnfile_resource_v1_operation !== "string"
    || !/^o[a-f0-9]{63}$/u.test(labels.spawnfile_resource_v1_operation)
    || typeof labels.spawnfile_resource_v1_run !== "string"
    || !/^r[a-f0-9]{63}$/u.test(labels.spawnfile_resource_v1_run)
    || typeof labels.spawnfile_resource_v1_target !== "string"
    || !/^t[a-f0-9]{63}$/u.test(labels.spawnfile_resource_v1_target)
    || labels.spawnfile_resource_v1_version !== "v1") return false;
  const inspectionFormat = value.kind === "data_network"
    ? "[{\"Name\":{{json .Name}},\"Labels\":{{json .Labels}},\"Internal\":{{json .Internal}}}]"
    : "[{\"Name\":{{json .Name}},\"Labels\":{{json .Labels}}}]";
  const labelArgs = labelKeys.flatMap((key) => ["--label", `${key}=${String(labels[key])}`]);
  const args = value.kind === "data_network"
    ? ["network", "create", "--internal", ...labelArgs, value.name]
    : ["volume", "create", ...labelArgs, value.name];
  try {
    return value.inspectionFormat === inspectionFormat
      && JSON.stringify(value.args) === JSON.stringify(args)
      && parseOpaqueTargetHandle(value.resultHandle) === value.resultHandle;
  } catch { return false; }
};

const digest = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-resource.${domain}.v1\0`, "utf8").update(value, "utf8").digest("hex");
const labelValue = (prefix: string, value: string): string => `${prefix}${digest("docker-resource-label", value).slice(0, 63)}`;

export const createDockerResourceSpec = (input: {
  kind: DockerResourceKind;
  operationHandle: OpaqueTargetHandle;
  requestDigest: string;
  runId: string;
  selectedTargetHandle: OpaqueTargetHandle;
}): DockerResourceSpec => {
  const authority = `${input.kind}\0${input.operationHandle}\0${input.requestDigest}`;
  const namePrefix = input.kind === "data_network" ? "spfn_" : "spfv_";
  const name = `${namePrefix}${digest("docker-resource-name", authority).slice(0, MAX_NAME_LENGTH - namePrefix.length)}`;
  const resultHandle = parseOpaqueTargetHandle(`opaque_${digest("docker-resource-result", authority)}`);
  const labels = Object.freeze({
    spawnfile_resource_v1_kind: input.kind,
    spawnfile_resource_v1_operation: labelValue("o", `${input.operationHandle}\0${input.requestDigest}`),
    spawnfile_resource_v1_run: labelValue("r", input.runId),
    spawnfile_resource_v1_target: labelValue("t", input.selectedTargetHandle),
    spawnfile_resource_v1_version: "v1"
  });
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const create = input.kind === "data_network"
    ? ["network", "create", "--internal", ...labelArgs, name]
    : ["volume", "create", ...labelArgs, name];
  const inspectionFormat = input.kind === "data_network"
    ? "[{\"Name\":{{json .Name}},\"Labels\":{{json .Labels}},\"Internal\":{{json .Internal}}}]"
    : "[{\"Name\":{{json .Name}},\"Labels\":{{json .Labels}}}]";
  return { args: create, inspectionFormat, kind: input.kind, labels, name, resultHandle };
};

const isUtf8 = (value: string): boolean => Buffer.from(value, "utf8").toString("utf8") === value;
const boundedText = (value: unknown): value is string => typeof value === "string" && isUtf8(value) && Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES;

export const executeDockerResource = async (input: {
  args: string[];
  executor: DockerResourceExecutor;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<{ stderr: string; stdout: string }> => {
  try {
    const result = await input.executor("docker", input.args, { signal: input.signal, timeout: input.timeoutMs });
    if (!result || !boundedText(result.stdout) || !boundedText(result.stderr)) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof DockerResourceProviderError) throw error;
    throw new Error(DOCKER_RESOURCE_ERROR);
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
  throw new Error();
};
const duplicateFreeValue = (source: string, start: number): number => {
  let index = skipWhitespace(source, start); const token = source[index];
  if (token === "\"") return stringEnd(source, index);
  if (token === "{") {
    index = skipWhitespace(source, index + 1); const keys = new Set<string>();
    if (source[index] === "}") return index + 1;
    while (true) {
      if (source[index] !== "\"") throw new Error();
      const end = stringEnd(source, index); const key = JSON.parse(source.slice(index, end)) as string;
      if (keys.has(key)) throw new Error(); keys.add(key); index = skipWhitespace(source, end);
      if (source[index] !== ":") throw new Error(); index = duplicateFreeValue(source, index + 1); index = skipWhitespace(source, index);
      if (source[index] === "}") return index + 1;
      if (source[index] !== ",") throw new Error(); index = skipWhitespace(source, index + 1);
    }
  }
  if (token === "[") {
    index = skipWhitespace(source, index + 1); if (source[index] === "]") return index + 1;
    while (true) { index = duplicateFreeValue(source, index); index = skipWhitespace(source, index); if (source[index] === "]") return index + 1; if (source[index] !== ",") throw new Error(); index = skipWhitespace(source, index + 1); }
  }
  while (index < source.length && !/[\t\n\r ,}\]]/u.test(source[index]!)) index += 1;
  if (index === start) throw new Error(); return index;
};

const parseInspection = (stdout: string): unknown => {
  if (!boundedText(stdout)) throw new Error();
  const end = duplicateFreeValue(stdout, 0);
  if (skipWhitespace(stdout, end) !== stdout.length) throw new Error();
  const parsed = JSON.parse(stdout) as unknown; assertOrdinaryJsonGraph(parsed); return parsed;
};
const exactLabels = (actual: unknown, expected: Readonly<Record<string, string>>): boolean => {
  if (!actual || typeof actual !== "object" || Array.isArray(actual) || Object.getPrototypeOf(actual) !== Object.prototype) return false;
  const record = actual as Record<string, unknown>; const actualKeys = Object.keys(record).sort(); const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index] && record[key] === expected[key]);
};

export const isExpectedDockerResource = (stdout: string, spec: DockerResourceSpec): boolean => {
  try {
    const parsed = parseInspection(stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) return false;
    const resource = parsed[0];
    if (!resource || typeof resource !== "object" || Array.isArray(resource) || Object.getPrototypeOf(resource) !== Object.prototype) return false;
    const record = resource as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expectedKeys = spec.kind === "data_network" ? ["Internal", "Labels", "Name"] : ["Labels", "Name"];
    return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
      && record.Name === spec.name && exactLabels(record.Labels, spec.labels)
      && (spec.kind !== "data_network" || record.Internal === true);
  } catch { return false; }
};
