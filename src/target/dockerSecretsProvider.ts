import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseRunId,
  type OpaqueTargetHandle
} from "./contracts.js";

export const DOCKER_SECRET_ERROR = "Docker secret materialization failed";
export const DOCKER_SECRET_WRITER_IMAGE = "docker.io/library/busybox@sha256:222ad6d973c0d198014546a65cd02c5fdedcc172123c5b4c2bf0af636550bd94";
export const MAX_SECRET_VALUE_BYTES = 1_048_576;
export const MAX_SECRET_ARCHIVE_BYTES = 4_194_304;

const MAX_OUTPUT_BYTES = 32_768;
const MAX_NAME_LENGTH = 63;
const TAR_BLOCK_BYTES = 512;
const SECRET_ROOT = "/run/spawnfile-secrets";
const WRITER_SCRIPT = `umask 077
root=${SECRET_ROOT}
find "$root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} \\;
tar -xpf - -C "$root"
test -f "$root/.spawnfile-complete"`;

export type DockerSecretFailureKind = "collision" | "not_found";
export interface DockerSecretExecutorOptions {
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;
  readonly timeout: number;
}
export interface DockerSecretExecutor {
  (file: string, args: string[], options: DockerSecretExecutorOptions): Promise<{ stderr: string; stdout: string }>;
}

/** A fixed, non-reflective classification supplied by the trusted Docker bridge. */
export class DockerSecretProviderError extends Error {
  public readonly kind: DockerSecretFailureKind;
  public constructor(kind: DockerSecretFailureKind) { super(DOCKER_SECRET_ERROR); this.kind = kind; }
}

export interface DockerSecretSpec {
  readonly labels: Readonly<Record<string, string>>;
  readonly resultHandle: OpaqueTargetHandle;
  readonly volumeInspectionFormat: string;
  readonly volumeName: string;
  readonly writerInspectionFormat: string;
  readonly writerEnv: readonly string[];
  readonly writerLabels: Readonly<Record<string, string>>;
  readonly writerName: string;
  readonly writerRunArgs: readonly string[];
}

export interface ResolvedSecretBinding {
  readonly name: string;
  readonly scope: string;
  readonly value: Uint8Array;
}

export interface DockerSecretWriterState {
  readonly exitCode: number;
  readonly status: "created" | "dead" | "exited" | "paused" | "removing" | "restarting" | "running";
}

const digest = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-secret.${domain}.v1\0`, "utf8").update(value, "utf8").digest("hex");
const labelValue = (prefix: string, value: string): string => `${prefix}${digest("docker-label", value).slice(0, 63)}`;
const resourceLabelValue = (prefix: string, value: string): string => `${prefix}${createHash("sha256")
  .update("spawnfile.target-resource.docker-resource-label.v1\0", "utf8").update(value, "utf8")
  .digest("hex").slice(0, 63)}`;
const validDigest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);

const createSpec = (input: {
  bindingsHandle: OpaqueTargetHandle;
  runId: string;
  selectedTargetHandle: OpaqueTargetHandle;
}): DockerSecretSpec => {
  const runId = parseRunId(input.runId);
  const authority = input.bindingsHandle;
  const volumeName = `spfs_${digest("volume-name", authority).slice(0, MAX_NAME_LENGTH - 5)}`;
  const writerName = `spfw_${digest("writer-name", authority).slice(0, MAX_NAME_LENGTH - 5)}`;
  const labels = Object.freeze({
    spawnfile_resource_v1_binding: labelValue("b", authority),
    spawnfile_resource_v1_kind: "secret_bindings",
    spawnfile_resource_v1_run: resourceLabelValue("r", runId),
    spawnfile_resource_v1_target: resourceLabelValue("t", input.selectedTargetHandle),
    spawnfile_resource_v1_version: "v1"
  });
  const writerLabels = Object.freeze({
    spawnfile_secret_writer_v1_binding: labelValue("b", authority),
    spawnfile_secret_writer_v1_run: labelValue("r", runId),
    spawnfile_secret_writer_v1_target: labelValue("t", input.selectedTargetHandle),
    spawnfile_secret_writer_v1_version: "v1"
  });
  const writerEnv = Object.freeze([
    "PATH=/bin:/usr/bin",
    `HOSTNAME=${writerName}`,
    "HOME=/root"
  ]);
  const labelArgs = Object.entries(writerLabels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const envArgs = writerEnv.flatMap((value) => ["--env", value]);
  const writerRunArgs = [
    "run", "--rm", "--interactive", "--quiet", "--pull", "missing", "--name", writerName,
    "--hostname", writerName, "--network", "none", "--ipc", "none", "--cgroupns", "private",
    "--restart", "no", "--privileged=false", "--publish-all=false", "--log-driver", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    "--user", "0:0", "--pids-limit", "32", "--memory", "32m", "--cpus", "0.25",
    ...envArgs, ...labelArgs,
    "--mount", `type=volume,src=${volumeName},dst=${SECRET_ROOT},volume-nocopy`,
    "--entrypoint", "/bin/sh", DOCKER_SECRET_WRITER_IMAGE, "-ceu", WRITER_SCRIPT
  ] as const;
  const volumeInspectionFormat = "[{\"Name\":{{json .Name}},\"Labels\":{{json .Labels}},\"Driver\":{{json .Driver}},\"Scope\":{{json .Scope}},\"Options\":{{json .Options}}}]";
  const writerInspectionFormat = "[{\"Name\":{{json .Name}},\"Image\":{{json .Config.Image}},\"Entrypoint\":{{json .Config.Entrypoint}},\"Cmd\":{{json .Config.Cmd}},\"User\":{{json .Config.User}},\"OpenStdin\":{{json .Config.OpenStdin}},\"Env\":{{json .Config.Env}},\"Hostname\":{{json .Config.Hostname}},\"Domainname\":{{json .Config.Domainname}},\"Labels\":{{json .Config.Labels}},\"AutoRemove\":{{json .HostConfig.AutoRemove}},\"ReadonlyRootfs\":{{json .HostConfig.ReadonlyRootfs}},\"NetworkMode\":{{json .HostConfig.NetworkMode}},\"NetworkAttachmentCount\":{{len .NetworkSettings.Networks}}{{range $name, $_ := .NetworkSettings.Networks}},\"NetworkAttachmentName\":{{json $name}}{{end}},\"PidMode\":{{json .HostConfig.PidMode}},\"IpcMode\":{{json .HostConfig.IpcMode}},\"UTSMode\":{{json .HostConfig.UTSMode}},\"UsernsMode\":{{json .HostConfig.UsernsMode}},\"CgroupnsMode\":{{json .HostConfig.CgroupnsMode}},\"RestartPolicyName\":{{json .HostConfig.RestartPolicy.Name}},\"RestartMaximumRetryCount\":{{json .HostConfig.RestartPolicy.MaximumRetryCount}},\"Privileged\":{{json .HostConfig.Privileged}},\"CapDrop\":{{json .HostConfig.CapDrop}},\"CapAddCount\":{{len .HostConfig.CapAdd}},\"DeviceCount\":{{len .HostConfig.Devices}},\"DeviceRequestCount\":{{len .HostConfig.DeviceRequests}},\"PortBindingCount\":{{len .HostConfig.PortBindings}},\"ExposedPortCount\":{{len .Config.ExposedPorts}},\"PublishAllPorts\":{{json .HostConfig.PublishAllPorts}},\"BindCount\":{{len .HostConfig.Binds}},\"VolumesFromCount\":{{len .HostConfig.VolumesFrom}},\"ExtraHostCount\":{{len .HostConfig.ExtraHosts}},\"DnsCount\":{{len .HostConfig.Dns}},\"GroupAddCount\":{{len .HostConfig.GroupAdd}},\"LinkCount\":{{len .HostConfig.Links}},\"SecurityOpt\":{{json .HostConfig.SecurityOpt}},\"LogType\":{{json .HostConfig.LogConfig.Type}},\"PidsLimit\":{{json .HostConfig.PidsLimit}},\"Memory\":{{json .HostConfig.Memory}},\"NanoCpus\":{{json .HostConfig.NanoCpus}},\"MountCount\":{{len .Mounts}}{{range .Mounts}},\"MountType\":{{json .Type}},\"MountName\":{{json .Name}},\"MountDestination\":{{json .Destination}},\"MountRW\":{{json .RW}}{{end}},\"Status\":{{json .State.Status}},\"ExitCode\":{{json .State.ExitCode}}}]";
  return { labels, resultHandle: input.bindingsHandle, volumeInspectionFormat, volumeName, writerEnv, writerInspectionFormat, writerLabels, writerName, writerRunArgs };
};

export const createPreparedDockerSecretSpec = (input: {
  operationHandle: OpaqueTargetHandle;
  requestDigest: string;
  runId: string;
  selectedTargetHandle: OpaqueTargetHandle;
}): DockerSecretSpec => {
  if (!validDigest(input.requestDigest)) throw new TypeError(DOCKER_SECRET_ERROR);
  const operationHandle = parseOpaqueTargetHandle(input.operationHandle);
  const bindingsHandle = parseOpaqueTargetHandle(`opaque_${digest("bindings-handle", `${operationHandle}\0${input.requestDigest}`)}`);
  return createSpec({ bindingsHandle, runId: input.runId, selectedTargetHandle: parseOpaqueTargetHandle(input.selectedTargetHandle) });
};

export const createExistingDockerSecretSpec = (input: {
  bindingsHandle: OpaqueTargetHandle;
  runId: string;
  selectedTargetHandle: OpaqueTargetHandle;
}): DockerSecretSpec => createSpec({
  bindingsHandle: parseOpaqueTargetHandle(input.bindingsHandle),
  runId: input.runId,
  selectedTargetHandle: parseOpaqueTargetHandle(input.selectedTargetHandle)
});

const isUtf8 = (value: string): boolean => Buffer.from(value, "utf8").toString("utf8") === value;
const boundedText = (value: unknown): value is string => typeof value === "string" && isUtf8(value) && Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES;

export const executeDockerSecretCommand = async (input: {
  args: string[];
  executor: DockerSecretExecutor;
  requireSilent?: boolean;
  signal?: AbortSignal;
  stdin?: Uint8Array;
  timeoutMs: number;
}): Promise<{ stderr: string; stdout: string }> => {
  try {
    const options: DockerSecretExecutorOptions = input.stdin === undefined
      ? { signal: input.signal, timeout: input.timeoutMs }
      : { signal: input.signal, stdin: input.stdin, timeout: input.timeoutMs };
    const result = await input.executor("docker", input.args, options);
    if (!result || !boundedText(result.stdout) || !boundedText(result.stderr)
      || input.requireSilent && (result.stdout !== "" || result.stderr !== "")) throw new Error();
    return result;
  } catch (error) {
    if (error instanceof DockerSecretProviderError) throw error;
    throw new Error(DOCKER_SECRET_ERROR);
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
  const end = duplicateFreeValue(stdout, 0); if (skipWhitespace(stdout, end) !== stdout.length) throw new Error();
  const parsed = JSON.parse(stdout) as unknown; assertOrdinaryJsonGraph(parsed); return parsed;
};
const exactRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const exactLabels = (actual: unknown, expected: Readonly<Record<string, string>>): boolean => exactRecord(actual, Object.keys(expected))
  && Object.entries(expected).every(([key, value]) => actual[key] === value);

export const isExpectedDockerSecretVolume = (stdout: string, spec: DockerSecretSpec): boolean => {
  try {
    const parsed = parseInspection(stdout); if (!Array.isArray(parsed) || parsed.length !== 1) return false;
    const resource = parsed[0]; return exactRecord(resource, ["Driver", "Labels", "Name", "Options", "Scope"])
      && resource.Name === spec.volumeName && exactLabels(resource.Labels, spec.labels)
      && resource.Driver === "local" && resource.Scope === "local" && resource.Options === null;
  } catch { return false; }
};

export const parseExpectedDockerSecretWriter = (stdout: string, spec: DockerSecretSpec): DockerSecretWriterState | null => {
  try {
    const parsed = parseInspection(stdout); if (!Array.isArray(parsed) || parsed.length !== 1) return null;
    const value = parsed[0];
    if (!exactRecord(value, [
      "AutoRemove", "BindCount", "CapAddCount", "CapDrop", "CgroupnsMode", "Cmd", "DeviceCount",
      "DeviceRequestCount", "DnsCount", "Domainname", "Entrypoint", "Env", "ExitCode", "ExposedPortCount",
      "ExtraHostCount", "GroupAddCount", "Hostname", "Image", "IpcMode", "Labels", "LinkCount", "LogType",
      "Memory", "MountCount", "MountDestination", "MountName", "MountRW", "MountType", "Name", "NanoCpus",
      "NetworkAttachmentCount", "NetworkAttachmentName", "NetworkMode", "OpenStdin", "PidMode", "PidsLimit",
      "PortBindingCount", "Privileged", "PublishAllPorts",
      "ReadonlyRootfs", "RestartMaximumRetryCount", "RestartPolicyName", "SecurityOpt", "Status", "User",
      "UsernsMode", "UTSMode", "VolumesFromCount"
    ])) return null;
    const status = value.Status;
    if (status !== "created" && status !== "dead" && status !== "exited" && status !== "paused"
      && status !== "removing" && status !== "restarting" && status !== "running") return null;
    if (!Number.isSafeInteger(value.ExitCode) || (value.ExitCode as number) < 0 || (value.ExitCode as number) > 255) return null;
    return value.Name === `/${spec.writerName}` && value.Image === DOCKER_SECRET_WRITER_IMAGE
      && JSON.stringify(value.Entrypoint) === JSON.stringify(["/bin/sh"])
      && JSON.stringify(value.Cmd) === JSON.stringify(["-ceu", WRITER_SCRIPT])
      && value.User === "0:0" && value.OpenStdin === true
      && JSON.stringify(value.Env) === JSON.stringify(spec.writerEnv)
      && value.Hostname === spec.writerName && value.Domainname === "" && exactLabels(value.Labels, spec.writerLabels)
      && value.AutoRemove === true && value.ReadonlyRootfs === true && value.NetworkMode === "none"
      && value.NetworkAttachmentCount === 1 && value.NetworkAttachmentName === "none"
      && value.PidMode === "" && value.IpcMode === "none" && value.UTSMode === ""
      && value.UsernsMode === "" && value.CgroupnsMode === "private"
      && value.RestartPolicyName === "no" && value.RestartMaximumRetryCount === 0 && value.Privileged === false
      && JSON.stringify(value.CapDrop) === JSON.stringify(["ALL"])
      && value.CapAddCount === 0 && value.DeviceCount === 0 && value.DeviceRequestCount === 0
      && value.PortBindingCount === 0 && value.ExposedPortCount === 0 && value.PublishAllPorts === false
      && value.BindCount === 0 && value.VolumesFromCount === 0 && value.ExtraHostCount === 0
      && value.DnsCount === 0 && value.GroupAddCount === 0 && value.LinkCount === 0
      && JSON.stringify(value.SecurityOpt) === JSON.stringify(["no-new-privileges=true"])
      && value.LogType === "none" && value.PidsLimit === 32 && value.Memory === 33_554_432
      && value.NanoCpus === 250_000_000 && value.MountCount === 1 && value.MountType === "volume"
      && value.MountName === spec.volumeName && value.MountDestination === SECRET_ROOT && value.MountRW === true
      ? { exitCode: value.ExitCode as number, status } : null;
  } catch { return null; }
};

const writeText = (block: Buffer, offset: number, length: number, value: string): void => {
  const bytes = Buffer.from(value, "ascii"); if (bytes.length > length) throw new TypeError(DOCKER_SECRET_ERROR); bytes.copy(block, offset);
};
const writeOctal = (block: Buffer, offset: number, length: number, value: number): void => {
  const text = value.toString(8); if (text.length > length - 1) throw new TypeError(DOCKER_SECRET_ERROR);
  writeText(block, offset, length, `${text.padStart(length - 1, "0")}\0`);
};
const tarHeader = (path: string, mode: number, size: number, type: "0" | "5"): Buffer => {
  const directory = path.endsWith("/"); const normalized = directory ? path.slice(0, -1) : path; const parts = normalized.split("/");
  let name = normalized; let prefix = "";
  if (Buffer.byteLength(`${name}${directory ? "/" : ""}`, "ascii") > 100) { name = parts.pop()!; prefix = parts.join("/"); }
  else if (directory) name += "/";
  const block = Buffer.alloc(TAR_BLOCK_BYTES); writeText(block, 0, 100, name); writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0); writeOctal(block, 116, 8, 0); writeOctal(block, 124, 12, size); writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156); writeText(block, 156, 1, type); writeText(block, 257, 6, "ustar\0"); writeText(block, 263, 2, "00");
  writeText(block, 345, 155, prefix); const checksum = block.reduce((sum, byte) => sum + byte, 0); const encoded = checksum.toString(8).padStart(6, "0");
  writeText(block, 148, 8, `${encoded}\0 `); return block;
};
const paddedSize = (size: number): number => Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;

export const createDockerSecretArchive = (bindings: readonly ResolvedSecretBinding[]): Buffer => {
  if (bindings.length < 1 || bindings.length > 32) throw new TypeError(DOCKER_SECRET_ERROR);
  const sorted = [...bindings].sort((left, right) => left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
  const keys = new Set<string>(); let valueBytes = 0; const scopes = new Set<string>();
  for (const binding of sorted) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(binding.name) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(binding.scope)
      || !(binding.value instanceof Uint8Array) || binding.value.byteLength < 1 || binding.value.byteLength > MAX_SECRET_VALUE_BYTES) throw new TypeError(DOCKER_SECRET_ERROR);
    const key = `${binding.scope}\0${binding.name}`; if (keys.has(key)) throw new TypeError(DOCKER_SECRET_ERROR); keys.add(key); scopes.add(binding.scope);
    valueBytes += binding.value.byteLength; if (valueBytes > MAX_SECRET_ARCHIVE_BYTES) throw new TypeError(DOCKER_SECRET_ERROR);
  }
  const chunks: Buffer[] = [];
  for (const scope of [...scopes].sort()) chunks.push(tarHeader(`${scope}/`, 0o700, 0, "5"));
  for (const binding of sorted) {
    chunks.push(tarHeader(`${binding.scope}/${binding.name}`, 0o400, binding.value.byteLength, "0"));
    const content = Buffer.alloc(paddedSize(binding.value.byteLength)); content.set(binding.value); chunks.push(content);
  }
  chunks.push(tarHeader(".spawnfile-complete", 0o400, 0, "0"), Buffer.alloc(TAR_BLOCK_BYTES * 2));
  const archive = Buffer.concat(chunks); for (const chunk of chunks) chunk.fill(0);
  if (archive.byteLength > MAX_SECRET_ARCHIVE_BYTES) { archive.fill(0); throw new TypeError(DOCKER_SECRET_ERROR); }
  return archive;
};
