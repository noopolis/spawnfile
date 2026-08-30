import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseRunId,
  type OpaqueTargetHandle
} from "./contracts.js";
import { isImmutableDockerImageReference } from "./dockerArtifactsProvider.js";
import { parseDuplicateFreeDockerProjection } from "./dockerProjectionJson.js";

export const DOCKER_WORLD_SERVICE_ERROR = "Docker world-service lifecycle failed";
export const WORLD_SECRETS_PATH = "/run/spawnfile-secrets" as const;
export const WORLD_RUNTIME_TMPFS = Object.freeze({
  path: "/tmp",
  options: "rw,noexec,nosuid,nodev,size=1m,mode=1777"
});
/*
 * A distinct mount point is a confinement boundary, not merely a convenient
 * directory.  The public-artifact reader opens one direct child with
 * O_NOFOLLOW; this mount prevents that child from being hard-linked or
 * replaced with a path from the world root, secrets, or evidence mounts.
 */
export const WORLD_PUBLIC_ARTIFACT_TMPFS = Object.freeze({
  path: "/tmp/spawnfile-public",
  options: "rw,noexec,nosuid,nodev,size=1m,mode=1777"
});

const MAX_OUTPUT_BYTES = 32_768;
const MAX_NAME_LENGTH = 63;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DOCKER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const NETWORK_NAME_PATTERN = /^spfn_[a-f0-9]{58}$/u;
const EVIDENCE_NAME_PATTERN = /^spfv_[a-f0-9]{58}$/u;
const SECRET_NAME_PATTERN = /^spfs_[a-f0-9]{58}$/u;
const RESOURCE_LABEL_KEYS = Object.freeze([
  "spawnfile_resource_v1_kind",
  "spawnfile_resource_v1_operation",
  "spawnfile_resource_v1_run",
  "spawnfile_resource_v1_target",
  "spawnfile_resource_v1_version"
] as const);
const SECRET_LABEL_KEYS = Object.freeze([
  "spawnfile_resource_v1_binding",
  "spawnfile_resource_v1_kind",
  "spawnfile_resource_v1_run",
  "spawnfile_resource_v1_target",
  "spawnfile_resource_v1_version"
] as const);
const WORLD_LABEL_KEYS = Object.freeze([
  "spawnfile_world_service_v1_artifact",
  "spawnfile_world_service_v1_evidence",
  "spawnfile_world_service_v1_kind",
  "spawnfile_world_service_v1_network",
  "spawnfile_world_service_v1_operation",
  "spawnfile_world_service_v1_run",
  "spawnfile_world_service_v1_secrets",
  "spawnfile_world_service_v1_target",
  "spawnfile_world_service_v1_version"
] as const);

export type DockerWorldServiceFailureKind = "collision" | "not_found";
export interface DockerWorldServiceExecutor {
  (
    file: string,
    args: string[],
    options: { readonly signal?: AbortSignal; readonly timeout: number }
  ): Promise<{ readonly stderr: string; readonly stdout: string }>;
}

export class DockerWorldServiceProviderError extends Error {
  public readonly kind: DockerWorldServiceFailureKind;
  public constructor(kind: DockerWorldServiceFailureKind) {
    super(DOCKER_WORLD_SERVICE_ERROR);
    this.kind = kind;
  }
}

interface NamedResource {
  readonly handle: OpaqueTargetHandle;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
}

export interface DockerWorldServiceSpec {
  readonly containerName: string;
  readonly createArgs: readonly string[];
  readonly imageDigest: string;
  readonly imageReference: string;
  readonly evidenceMountPath: string;
  readonly networkAlias?: string;
  readonly inspectionFormat: string;
  readonly receiptLabels: Readonly<Record<string, string>>;
  readonly resultHandle: OpaqueTargetHandle;
}

export interface DockerWorldServiceInspection {
  readonly containerId: string;
  readonly networkId: string;
  readonly status: "created" | "dead" | "exited" | "paused" | "removing" | "restarting" | "running";
}

const fail = (): never => { throw new Error(DOCKER_WORLD_SERVICE_ERROR); };
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const digest = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-world-service.${domain}.v1\0`, "utf8")
  .update(value, "utf8")
  .digest("hex");
const label = (prefix: string, value: string): string =>
  `${prefix}${digest("docker-label", value).slice(0, 63)}`;
const exactRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
};

const parseResourceLabels = (
  raw: unknown,
  kind: "data_network" | "evidence_volume" | "secret_bindings"
): Readonly<Record<string, string>> => {
  assertOrdinaryJsonGraph(raw);
  const keys = kind === "secret_bindings" ? SECRET_LABEL_KEYS : RESOURCE_LABEL_KEYS;
  if (!exactRecord(raw) || !exactKeys(raw, keys)
    || raw.spawnfile_resource_v1_kind !== kind
    || raw.spawnfile_resource_v1_version !== "v1") return fail();
  for (const key of keys) {
    const value = raw[key];
    if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) return fail();
  }
  const authorityKeys = kind === "secret_bindings"
    ? ["spawnfile_resource_v1_binding", "spawnfile_resource_v1_run", "spawnfile_resource_v1_target"]
    : ["spawnfile_resource_v1_operation", "spawnfile_resource_v1_run", "spawnfile_resource_v1_target"];
  if (authorityKeys.some((key) => !/^[a-z][a-f0-9]{63}$/u.test(raw[key] as string))) return fail();
  return Object.freeze({ ...raw }) as Readonly<Record<string, string>>;
};

const parseResource = (
  raw: unknown,
  kind: "data_network" | "evidence_volume" | "secret_bindings"
): NamedResource => {
  assertOrdinaryJsonGraph(raw);
  if (!exactRecord(raw) || !exactKeys(raw, ["handle", "labels", "name"])) return fail();
  const pattern = kind === "data_network" ? NETWORK_NAME_PATTERN
    : kind === "evidence_volume" ? EVIDENCE_NAME_PATTERN : SECRET_NAME_PATTERN;
  if (typeof raw.name !== "string" || !pattern.test(raw.name)) return fail();
  return Object.freeze({
    handle: parseOpaqueTargetHandle(raw.handle),
    labels: parseResourceLabels(raw.labels, kind),
    name: raw.name
  });
};

const rawInspectionFormat = (): string => {
  const labels = WORLD_LABEL_KEYS.map((key) =>
    `${JSON.stringify(key)}:{{json (index .Config.Labels ${JSON.stringify(key)})}}`).join(",");
  return `[{"Id":{{json .Id}},"Name":{{json .Name}},"Hostname":{{json .Config.Hostname}},"Domainname":{{json .Config.Domainname}},"Image":{{json .Config.Image}},"Labels":{${labels}},"NetworkMode":{{json .HostConfig.NetworkMode}},"NetworkAttachmentCount":{{len .NetworkSettings.Networks}},"NetworkAttachmentName":{{range $name, $_ := .NetworkSettings.Networks}}{{json $name}}{{end}},"NetworkAttachmentId":{{range $_, $network := .NetworkSettings.Networks}}{{json $network.NetworkID}}{{end}},"NetworkAliases":{{range $_, $network := .NetworkSettings.Networks}}{{json $network.Aliases}}{{end}},"PortBindingCount":{{len .HostConfig.PortBindings}},"ExposedPortCount":{{with (index .Config "ExposedPorts")}}{{len .}}{{else}}0{{end}},"PublishAllPorts":{{json .HostConfig.PublishAllPorts}},"Mounts":[{{range $index, $mount := .Mounts}}{{if $index}},{{end}}{"Type":{{json $mount.Type}},"Name":{{json $mount.Name}},"Destination":{{json $mount.Destination}},"RW":{{json $mount.RW}}}{{end}}],"Tmpfs":{{json .HostConfig.Tmpfs}},"AutoRemove":{{json .HostConfig.AutoRemove}},"Privileged":{{json .HostConfig.Privileged}},"CapDrop":{{json .HostConfig.CapDrop}},"CapAddCount":{{len .HostConfig.CapAdd}},"DeviceCount":{{len .HostConfig.Devices}},"DeviceRequestCount":{{len .HostConfig.DeviceRequests}},"ExtraHostCount":{{len .HostConfig.ExtraHosts}},"LinkCount":{{len .HostConfig.Links}},"BindCount":{{len .HostConfig.Binds}},"VolumesFromCount":{{len .HostConfig.VolumesFrom}},"DnsCount":{{len .HostConfig.Dns}},"GroupAddCount":{{len .HostConfig.GroupAdd}},"PidMode":{{json .HostConfig.PidMode}},"IpcMode":{{json .HostConfig.IpcMode}},"UTSMode":{{json .HostConfig.UTSMode}},"UsernsMode":{{json .HostConfig.UsernsMode}},"CgroupnsMode":{{json .HostConfig.CgroupnsMode}},"ReadonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"SecurityOpt":{{json .HostConfig.SecurityOpt}},"LogType":{{json .HostConfig.LogConfig.Type}},"RestartPolicyName":{{json .HostConfig.RestartPolicy.Name}},"RestartMaximumRetryCount":{{json .HostConfig.RestartPolicy.MaximumRetryCount}},"Status":{{json .State.Status}}}]`;
};

const safeDockerTemplateLength = (expression: string): string =>
  `{{with ${expression}}}{{len .}}{{else}}0{{end}}`;

const inspectionFormat = (): string => {
  let template = rawInspectionFormat();
  for (const expression of [
    ".HostConfig.CapAdd",
    ".HostConfig.Devices",
    ".HostConfig.DeviceRequests",
    ".HostConfig.ExtraHosts",
    ".HostConfig.Links",
    ".HostConfig.Binds",
    ".HostConfig.VolumesFrom",
    ".HostConfig.Dns",
    ".HostConfig.GroupAdd"
  ]) {
    template = template.replace(
      `{{len ${expression}}}`,
      safeDockerTemplateLength(expression)
    );
  }
  return template;
};

export const createDockerWorldServiceSpec = (input: {
  readonly operationHandle: unknown;
  readonly requestDigest: unknown;
  readonly runId: unknown;
  readonly selectedTargetHandle: unknown;
  readonly imageReference: unknown;
  readonly imageDigest: unknown;
  readonly dataNetwork: unknown;
  readonly evidenceVolume: unknown;
  readonly evidenceMountPath: unknown;
  readonly secretBindings: unknown;
  readonly networkAlias?: unknown;
}): DockerWorldServiceSpec => {
  try {
    assertOrdinaryJsonGraph(input);
    if (!exactRecord(input) || !exactKeys(input, Object.prototype.hasOwnProperty.call(input, "networkAlias") ? [
      "dataNetwork", "evidenceMountPath", "evidenceVolume", "imageDigest", "imageReference",
      "networkAlias", "operationHandle", "requestDigest", "runId", "secretBindings",
      "selectedTargetHandle"
    ] : [
      "dataNetwork", "evidenceMountPath", "evidenceVolume", "imageDigest", "imageReference",
      "operationHandle", "requestDigest", "runId", "secretBindings",
      "selectedTargetHandle"
    ])) return fail();
    const operationHandle = parseOpaqueTargetHandle(input.operationHandle);
    const selectedTargetHandle = parseOpaqueTargetHandle(input.selectedTargetHandle);
    const runId = parseRunId(input.runId);
    if (typeof input.requestDigest !== "string" || !DIGEST_PATTERN.test(input.requestDigest)
      || typeof input.imageDigest !== "string" || !DIGEST_PATTERN.test(input.imageDigest)
      || !(isImmutableDockerImageReference(input.imageReference)
        && input.imageReference.endsWith(`@${input.imageDigest}`)
        || input.imageReference === input.imageDigest)) return fail();
    const networkAlias = input.networkAlias === undefined ? undefined
      : typeof input.networkAlias === "string" && /^[a-z][a-z0-9-]{0,62}$/u.test(input.networkAlias)
        ? input.networkAlias : fail();
    const evidenceMountPath = typeof input.evidenceMountPath === "string"
      && input.evidenceMountPath.length <= 255
      && /^\/(?:run|var\/lib)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(input.evidenceMountPath)
      && !input.evidenceMountPath.includes("//") && !input.evidenceMountPath.endsWith("/")
      && !input.evidenceMountPath.split("/").some((part) => part === "." || part === "..")
      && input.evidenceMountPath !== WORLD_SECRETS_PATH
      && !input.evidenceMountPath.startsWith(`${WORLD_SECRETS_PATH}/`)
      && !WORLD_SECRETS_PATH.startsWith(`${input.evidenceMountPath}/`)
      ? input.evidenceMountPath : fail();
    const network = parseResource(input.dataNetwork, "data_network");
    const evidence = parseResource(input.evidenceVolume, "evidence_volume");
    const secrets = parseResource(input.secretBindings, "secret_bindings");
    if (new Set([network.handle, evidence.handle, secrets.handle]).size !== 3
      || !["spawnfile_resource_v1_run", "spawnfile_resource_v1_target"].every((key) =>
        network.labels[key] === evidence.labels[key] && network.labels[key] === secrets.labels[key])) return fail();
    const authority = [operationHandle, input.requestDigest, input.imageDigest,
      network.handle, evidence.handle, secrets.handle, evidenceMountPath].join("\0");
    const containerName = `spfc_${digest("container-name", authority).slice(0, MAX_NAME_LENGTH - 5)}`;
    const receiptLabels = Object.freeze({
      spawnfile_world_service_v1_artifact: label("a", input.imageDigest),
      spawnfile_world_service_v1_evidence: label("e", evidence.handle),
      spawnfile_world_service_v1_kind: "world_service",
      spawnfile_world_service_v1_network: label("n", network.handle),
      spawnfile_world_service_v1_operation: label("o", `${operationHandle}\0${input.requestDigest}`),
      spawnfile_world_service_v1_run: label("r", runId),
      spawnfile_world_service_v1_secrets: label("s", secrets.handle),
      spawnfile_world_service_v1_target: label("t", selectedTargetHandle),
      spawnfile_world_service_v1_version: "v1"
    });
    const labelArgs = Object.entries(receiptLabels)
      .flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    const createArgs = Object.freeze([
      "container", "create", "--pull", "never", "--name", containerName,
      "--hostname", containerName, "--network", network.name,
      ...(networkAlias ? ["--network-alias", networkAlias] : []),
      "--restart", "no", "--privileged=false",
      "--publish-all=false", "--log-driver", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
      "--ipc", "none", "--cgroupns", "private",
      "--tmpfs", `${WORLD_RUNTIME_TMPFS.path}:${WORLD_RUNTIME_TMPFS.options}`,
      "--tmpfs", `${WORLD_PUBLIC_ARTIFACT_TMPFS.path}:${WORLD_PUBLIC_ARTIFACT_TMPFS.options}`,
      ...labelArgs,
      "--mount", `type=volume,src=${evidence.name},dst=${evidenceMountPath},volume-nocopy`,
      "--mount", `type=volume,src=${secrets.name},dst=${WORLD_SECRETS_PATH},readonly,volume-nocopy`,
      input.imageReference
    ]);
    return Object.freeze({
      containerName,
      createArgs,
      evidenceMountPath,
      imageDigest: input.imageDigest,
      imageReference: input.imageReference,
      ...(networkAlias ? { networkAlias } : {}),
      inspectionFormat: inspectionFormat(),
      receiptLabels,
      resultHandle: parseOpaqueTargetHandle(`opaque_${digest("result", authority)}`)
    });
  } catch { return fail(); }
};

const isUtf8 = (value: string): boolean =>
  Buffer.from(value, "utf8").toString("utf8") === value;
const boundedText = (value: unknown): value is string =>
  typeof value === "string" && isUtf8(value) && bytes(value) <= MAX_OUTPUT_BYTES;

export const executeDockerWorldService = async (input: {
  readonly args: string[];
  readonly executor: DockerWorldServiceExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<{ readonly stderr: string; readonly stdout: string }> => {
  try {
    const result = await input.executor("docker", input.args, {
      signal: input.signal,
      timeout: input.timeoutMs
    });
    if (!result || !boundedText(result.stdout) || !boundedText(result.stderr)) return fail();
    return result;
  } catch (error) {
    if (error instanceof DockerWorldServiceProviderError) throw error;
    return fail();
  }
};

const parseProjection = (stdout: string): Record<string, unknown> | null => {
  try {
    if (!boundedText(stdout)) return null;
    const raw = parseDuplicateFreeDockerProjection(stdout);
    assertOrdinaryJsonGraph(raw);
    if (!Array.isArray(raw) || raw.length !== 1 || !exactRecord(raw[0])) return null;
    return raw[0];
  } catch { return null; }
};
const exactLabels = (raw: unknown, expected: Readonly<Record<string, string>>): boolean =>
  exactRecord(raw) && exactKeys(raw, WORLD_LABEL_KEYS)
  && Object.entries(expected).every(([key, value]) => raw[key] === value);
const exactMounts = (raw: unknown, spec: DockerWorldServiceSpec): boolean => {
  if (!Array.isArray(raw) || raw.length !== 2) return false;
  const mounts = raw.every((item) => exactRecord(item)
    && exactKeys(item, ["Destination", "Name", "RW", "Type"]))
    ? raw as Array<Record<string, unknown>> : [];
  if (mounts.length !== 2) return false;
  const evidence = mounts.find((mount) => mount.Destination === spec.evidenceMountPath);
  const secrets = mounts.find((mount) => mount.Destination === WORLD_SECRETS_PATH);
  const evidenceArg = spec.createArgs.find((value) => value.includes(`dst=${spec.evidenceMountPath}`));
  const secretsArg = spec.createArgs.find((value) => value.includes(`dst=${WORLD_SECRETS_PATH}`));
  const source = (value: string | undefined): string | null =>
    value?.match(/(?:^|,)src=([^,]+)/u)?.[1] ?? null;
  return Boolean(evidence && secrets
    && evidence.Type === "volume" && evidence.Name === source(evidenceArg) && evidence.RW === true
    && secrets.Type === "volume" && secrets.Name === source(secretsArg) && secrets.RW === false);
};

export const parseExpectedDockerWorldService = (
  stdout: string,
  spec: DockerWorldServiceSpec
): DockerWorldServiceInspection | null => {
  const value = parseProjection(stdout);
  if (!value || !exactKeys(value, [
    "AutoRemove", "BindCount", "CapAddCount", "CapDrop", "CgroupnsMode", "DeviceCount",
    "DeviceRequestCount", "DnsCount", "Domainname", "ExposedPortCount", "ExtraHostCount",
    "GroupAddCount", "Hostname", "Id", "Image", "IpcMode", "Labels", "LinkCount", "LogType", "Mounts", "Name",
    "NetworkAliases", "NetworkAttachmentCount", "NetworkAttachmentId", "NetworkAttachmentName", "NetworkMode", "PidMode",
    "PortBindingCount", "Privileged", "PublishAllPorts", "ReadonlyRootfs",
    "RestartMaximumRetryCount", "RestartPolicyName", "SecurityOpt", "Status", "UTSMode",
    "Tmpfs", "UsernsMode", "VolumesFromCount"
  ])) return null;
  const status = value.Status;
  if (status !== "created" && status !== "dead" && status !== "exited"
    && status !== "paused" && status !== "removing" && status !== "restarting"
    && status !== "running") return null;
  if (typeof value.NetworkAttachmentId !== "string") return null;
  const networkAttachmentId = value.NetworkAttachmentId;
  const exactNetworkId = DOCKER_ID_PATTERN.test(networkAttachmentId)
    || status === "created" && networkAttachmentId === "";
  const exactAliases = spec.networkAlias
    ? Array.isArray(value.NetworkAliases)
      && value.NetworkAliases.length === 1
      && value.NetworkAliases[0] === spec.networkAlias
    : value.NetworkAliases === null
      || Array.isArray(value.NetworkAliases) && value.NetworkAliases.length === 0;
  if (typeof value.Id !== "string" || !DOCKER_ID_PATTERN.test(value.Id)
    || !exactNetworkId) return null;
  return value.Name === `/${spec.containerName}` && value.Hostname === spec.containerName
    && value.Domainname === "" && value.Image === spec.imageReference
    && exactLabels(value.Labels, spec.receiptLabels)
    && value.NetworkMode === resourceName(spec.createArgs, "--network")
    && value.NetworkAttachmentCount === 1
    && value.NetworkAttachmentName === resourceName(spec.createArgs, "--network")
    && exactAliases
    && value.PortBindingCount === 0
    && value.ExposedPortCount === 0 && value.PublishAllPorts === false
    && exactMounts(value.Mounts, spec) && value.AutoRemove === false
    && value.Privileged === false
    && JSON.stringify(value.CapDrop) === JSON.stringify(["ALL"])
    && value.CapAddCount === 0 && value.DeviceCount === 0 && value.DeviceRequestCount === 0
    && value.ExtraHostCount === 0 && value.LinkCount === 0 && value.BindCount === 0
    && value.VolumesFromCount === 0 && value.DnsCount === 0 && value.GroupAddCount === 0
    && value.PidMode === "" && value.IpcMode === "none" && value.UTSMode === ""
    && value.UsernsMode === "" && value.CgroupnsMode === "private"
    && exactRecord(value.Tmpfs)
    && exactKeys(value.Tmpfs, [WORLD_RUNTIME_TMPFS.path, WORLD_PUBLIC_ARTIFACT_TMPFS.path])
    && value.Tmpfs[WORLD_RUNTIME_TMPFS.path] === WORLD_RUNTIME_TMPFS.options
    && value.Tmpfs[WORLD_PUBLIC_ARTIFACT_TMPFS.path] === WORLD_PUBLIC_ARTIFACT_TMPFS.options
    && value.ReadonlyRootfs === true
    && JSON.stringify(value.SecurityOpt) === JSON.stringify(["no-new-privileges=true"])
    && value.LogType === "none" && value.RestartPolicyName === "no"
    && value.RestartMaximumRetryCount === 0
    ? Object.freeze({ containerId: value.Id, networkId: networkAttachmentId, status }) : null;
};

const resourceName = (args: readonly string[], flag: "--network"): string | null => {
  const index = args.indexOf(flag);
  return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1]! : null;
};
