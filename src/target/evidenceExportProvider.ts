import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { parseOpaqueTargetHandle, parseRunId, type OpaqueTargetHandle } from "./contracts.js";
import { isImmutableDockerImageReference } from "./dockerArtifactsProvider.js";
import { boundedRedactedText } from "../shared/index.js";

export const EVIDENCE_EXPORT_ERROR = "Evidence-volume export failed";
export const EVIDENCE_EXPORT_MOUNT = "/spawnfile/evidence" as const;
export const EVIDENCE_EXPORT_HELPER_CONTRACT = "spawnfile.target-evidence-export.helper.v1" as const;
export const EVIDENCE_EXPORT_HELPER_CONTRACT_VERSION = "v1" as const;
export const EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL = "spawnfile.target.evidence-export.helper-contract" as const;
export const EVIDENCE_EXPORT_HELPER_ENTRYPOINT: readonly string[] = Object.freeze(["/bin/spawnfile-export-helper"]);
export const EVIDENCE_EXPORT_HELPER_CMD: readonly string[] = Object.freeze([]);
export const EVIDENCE_EXPORT_HELPER_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" as const;
export const EVIDENCE_EXPORT_HELPER_ENV: readonly string[] = Object.freeze([
  `PATH=${EVIDENCE_EXPORT_HELPER_PATH}`,
]);
export const EVIDENCE_EXPORT_HELPER_USER = "65534:65534" as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const NAME = /^spfe_[a-f0-9]{58}$/u;
const MAX_OUTPUT_BYTES = 67_108_864;
export interface DockerEvidenceExportExecutor { (file: string, args: readonly string[], options: { readonly signal?: AbortSignal; readonly timeout: number }): Promise<{ readonly bytes: Uint8Array }>; }
export interface DockerEvidenceInspectionExecutor { (file: string, args: string[], options: { readonly signal?: AbortSignal; readonly timeout: number }): Promise<{ readonly stderr: string; readonly stdout: string }>; }
export interface EvidenceVolumeAuthority { readonly labels: Readonly<Record<string, string>>; readonly name: string; readonly resultHandle: OpaqueTargetHandle; }
/** Resolved only from B91's private immutable artifact identity store. */
export interface EvidenceExportHelper {
  readonly artifactManifestDigest: string;
  readonly image_digest: string;
  readonly image_reference: string;
  readonly result_handle: OpaqueTargetHandle;
}
export interface EvidenceExportHelperImageInspection {
  readonly labels: Readonly<Record<string, string>>;
}
export interface EvidenceExportHelperSpec {
  readonly containerName: string;
  readonly createArgs: readonly string[];
  readonly imageLabels: Readonly<Record<string, string>>;
  readonly imageReference: string;
  readonly inspectionFormat: string;
}
const fail = (reason?: string): never => { throw new Error(`${EVIDENCE_EXPORT_ERROR}${reason === undefined ? "" : ` (${reason})`}`); };
const hash = (domain: string, value: string): string => createHash("sha256").update(`spawnfile.target-evidence-export.${domain}.v1\0`).update(value).digest("hex");
const exact = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> => raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype && Object.keys(raw).sort().join("\0") === [...keys].sort().join("\0");
const record = (raw: unknown): Readonly<Record<string, string>> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const value = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!utf8(key) || typeof candidate !== "string" || !utf8(candidate)) return fail();
    out[key] = candidate;
  }
  return Object.freeze(out);
};
const utf8 = (value: unknown): value is string => typeof value === "string" && Buffer.from(value, "utf8").toString("utf8") === value && Buffer.byteLength(value, "utf8") <= 32_768;
const json = (raw: string): unknown => { if (!utf8(raw)) return fail(); try { return JSON.parse(raw) as unknown; } catch { return fail(); } };
const exactHelperEnv = (raw: unknown): boolean => Array.isArray(raw)
  && raw.length === 1 && raw[0] === EVIDENCE_EXPORT_HELPER_ENV[0];
export const createEvidenceExportHelper = (raw: { artifactManifestDigest: unknown; imageDigest: unknown; imageReference: unknown; resultHandle: unknown }): EvidenceExportHelper => {
  const localConfig = raw.imageReference === raw.imageDigest;
  if (typeof raw.artifactManifestDigest !== "string" || !DIGEST.test(raw.artifactManifestDigest) || typeof raw.imageDigest !== "string" || !DIGEST.test(raw.imageDigest) || typeof raw.imageReference !== "string" || !localConfig && (!isImmutableDockerImageReference(raw.imageReference) || !raw.imageReference.endsWith(`@${raw.imageDigest}`))) return fail();
  return Object.freeze({ artifactManifestDigest: raw.artifactManifestDigest, image_digest: raw.imageDigest, image_reference: raw.imageReference, result_handle: parseOpaqueTargetHandle(raw.resultHandle) });
};
export const parseEvidenceVolumeAuthority = (raw: unknown): EvidenceVolumeAuthority => {
  if (!exact(raw, ["labels", "name", "resultHandle"]) || typeof raw.name !== "string" || !/^spfv_[a-f0-9]{58}$/u.test(raw.name) || !exact(raw.labels, ["spawnfile_resource_v1_kind", "spawnfile_resource_v1_operation", "spawnfile_resource_v1_run", "spawnfile_resource_v1_target", "spawnfile_resource_v1_version"])) return fail();
  const labels = raw.labels; if (labels.spawnfile_resource_v1_kind !== "evidence_volume" || labels.spawnfile_resource_v1_version !== "v1" || Object.values(labels).some((value) => typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value))) return fail();
  return Object.freeze({ labels: Object.freeze({ ...labels } as Record<string, string>), name: raw.name, resultHandle: parseOpaqueTargetHandle(raw.resultHandle) });
};
export const createEvidenceExportHandle = (input: { readonly evidenceVolumeHandle: unknown; readonly operationHandle: unknown; readonly requestDigest: unknown }): OpaqueTargetHandle => {
  if (typeof input.requestDigest !== "string" || !DIGEST.test(input.requestDigest)) return fail(); return parseOpaqueTargetHandle(`opaque_${hash("result", `${parseOpaqueTargetHandle(input.evidenceVolumeHandle)}\0${parseOpaqueTargetHandle(input.operationHandle)}\0${input.requestDigest}`)}`);
};
export const evidenceDigest = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const evidenceReceiptLabels = (authority: EvidenceVolumeAuthority): Array<{ key: string; value: string }> => Object.entries(parseEvidenceVolumeAuthority(authority).labels).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value }));
export const assertExportRun = (authority: EvidenceVolumeAuthority, input: { readonly runId: unknown; readonly selectedTargetHandle: unknown }): void => {
  const parsed = parseEvidenceVolumeAuthority(authority); const label = (prefix: string, value: string): string => `${prefix}${createHash("sha256").update("spawnfile.target-resource.docker-resource-label.v1\0").update(value).digest("hex").slice(0, 63)}`;
  if (parsed.labels.spawnfile_resource_v1_run !== label("r", parseRunId(input.runId)) || parsed.labels.spawnfile_resource_v1_target !== label("t", parseOpaqueTargetHandle(input.selectedTargetHandle))) return fail();
};
export const createEvidenceExportHelperSpec = (input: {
  readonly authority: EvidenceVolumeAuthority;
  readonly helper: EvidenceExportHelper;
  readonly imageLabels: Readonly<Record<string, string>>;
  readonly operationHandle: OpaqueTargetHandle;
  readonly requestDigest: string;
}): EvidenceExportHelperSpec => {
  const authority = parseEvidenceVolumeAuthority(input.authority);
  const helper = createEvidenceExportHelper({ artifactManifestDigest: input.helper.artifactManifestDigest, imageDigest: input.helper.image_digest, imageReference: input.helper.image_reference, resultHandle: input.helper.result_handle });
  const imageLabels = record(input.imageLabels);
  if (!exact(imageLabels, [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL])) return fail();
  if (imageLabels[EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL] !== EVIDENCE_EXPORT_HELPER_CONTRACT_VERSION) return fail();
  if (!DIGEST.test(input.requestDigest)) return fail(); const containerName = `spfe_${hash("container", `${helper.result_handle}\0${input.operationHandle}\0${input.requestDigest}`).slice(0, 58)}`; if (!NAME.test(containerName)) return fail();
  const labels = [`spawnfile_evidence_export_v1_helper=${hash("label", helper.result_handle).slice(0, 63)}`, `spawnfile_evidence_export_v1_operation=${hash("label", `${input.operationHandle}\0${input.requestDigest}`).slice(0, 63)}`, "spawnfile_evidence_export_v1_version=v1"];
  return Object.freeze({
    containerName,
    imageReference: helper.image_reference,
    imageLabels,
    inspectionFormat: "[{\"Name\":{{json .Name}},\"Config\":{\"Env\":{{json .Config.Env}},\"Entrypoint\":{{json .Config.Entrypoint}},\"Cmd\":{{json .Config.Cmd}},\"ExposedPorts\":{{json (index .Config \"ExposedPorts\")}},\"Healthcheck\":{{json (index .Config \"Healthcheck\")}},\"Image\":{{json .Config.Image}},\"Labels\":{{json .Config.Labels}},\"User\":{{json .Config.User}},\"Volumes\":{{json .Config.Volumes}}},\"HostConfig\":{\"AutoRemove\":{{json .HostConfig.AutoRemove}},\"NetworkMode\":{{json .HostConfig.NetworkMode}},\"ReadonlyRootfs\":{{json .HostConfig.ReadonlyRootfs}},\"Privileged\":{{json .HostConfig.Privileged}},\"CapAdd\":{{json .HostConfig.CapAdd}},\"CapDrop\":{{json .HostConfig.CapDrop}},\"SecurityOpt\":{{json .HostConfig.SecurityOpt}},\"PidsLimit\":{{json .HostConfig.PidsLimit}},\"Memory\":{{json .HostConfig.Memory}},\"NanoCpus\":{{json .HostConfig.NanoCpus}},\"IpcMode\":{{json .HostConfig.IpcMode}},\"PidMode\":{{json .HostConfig.PidMode}},\"UTSMode\":{{json .HostConfig.UTSMode}},\"UsernsMode\":{{json .HostConfig.UsernsMode}},\"CgroupnsMode\":{{json .HostConfig.CgroupnsMode}},\"Binds\":{{json .HostConfig.Binds}},\"VolumesFrom\":{{json .HostConfig.VolumesFrom}},\"ExtraHosts\":{{json .HostConfig.ExtraHosts}},\"Dns\":{{json .HostConfig.Dns}},\"Links\":{{json .HostConfig.Links}},\"GroupAdd\":{{json .HostConfig.GroupAdd}},\"Devices\":{{json .HostConfig.Devices}},\"DeviceRequests\":{{json .HostConfig.DeviceRequests}},\"PortBindings\":{{json .HostConfig.PortBindings}},\"PublishAllPorts\":{{json .HostConfig.PublishAllPorts}},\"RestartPolicy\":{{json .HostConfig.RestartPolicy}},\"LogConfig\":{{json .HostConfig.LogConfig}}},\"Mounts\":[{{range $index,$mount := .Mounts}}{{if $index}},{{end}}{\"Destination\":{{json $mount.Destination}},\"Name\":{{json $mount.Name}},\"RW\":{{json $mount.RW}},\"Type\":{{json $mount.Type}}}{{end}}]}]",
    createArgs: Object.freeze(["container", "create", "--pull", "never", "--name", containerName, "--network", "none", "--restart", "no", "--privileged=false", "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--pids-limit", "64", "--memory", "128m", "--cpus", "0.25", "--ipc", "none", "--cgroupns", "private", "--label", labels[0]!, "--label", labels[1]!, "--label", labels[2]!, "--mount", `type=volume,src=${authority.name},dst=${EVIDENCE_EXPORT_MOUNT},readonly,volume-nocopy`, helper.image_reference])
  });
};
export const parseEvidenceExportImageInspection = (stdout: string, helper: EvidenceExportHelper): EvidenceExportHelperImageInspection => {
  const value = json(stdout);
  const prepared = createEvidenceExportHelper({ artifactManifestDigest: helper.artifactManifestDigest, imageDigest: helper.image_digest, imageReference: helper.image_reference, resultHandle: helper.result_handle });
  if (!Array.isArray(value) || value.length !== 1 || !exact(value[0], ["Config", "RepoDigests"])) return fail();
  const image = value[0] as Record<string, unknown>;
  const localConfig = prepared.image_reference === prepared.image_digest;
  if (!localConfig && (!Array.isArray(image.RepoDigests) || image.RepoDigests.length < 1 || image.RepoDigests.length > 32 || image.RepoDigests.some((value: unknown) => !isImmutableDockerImageReference(value)))) return fail();
  if (!exact(image.Config, ["Cmd", "Entrypoint", "Env", "ExposedPorts", "Healthcheck", "Labels", "User", "Volumes"])) return fail();
  const config = image.Config as Record<string, unknown>;
  const labels = record(config.Labels);
  if (!exact(labels, [EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL]) || labels[EVIDENCE_EXPORT_HELPER_CONTRACT_LABEL] !== EVIDENCE_EXPORT_HELPER_CONTRACT_VERSION) return fail();
  if (!Array.isArray(config.Entrypoint) || JSON.stringify(config.Entrypoint) !== JSON.stringify(EVIDENCE_EXPORT_HELPER_ENTRYPOINT)) return fail();
  if (config.Cmd !== null && !(Array.isArray(config.Cmd) && config.Cmd.length === 0)) return fail();
  if (config.User !== EVIDENCE_EXPORT_HELPER_USER) return fail();
  if (!exactHelperEnv(config.Env)
    || config.ExposedPorts !== null || config.Healthcheck !== null || config.Volumes !== null) return fail();
  if (!localConfig && !(image.RepoDigests as unknown[]).includes(prepared.image_reference)) return fail();
  return { labels: Object.freeze({ ...labels }) };
};
export const isExpectedEvidenceExportImage = (stdout: string, helper: EvidenceExportHelper): boolean => {
  try { parseEvidenceExportImageInspection(stdout, helper); return true; } catch { return false; }
};
export const isExpectedEvidenceExportHelper = (stdout: string, spec: EvidenceExportHelperSpec): boolean => {
  try {
    const value = json(stdout);
    if (!Array.isArray(value) || value.length !== 1 || !exact(value[0], ["Config", "HostConfig", "Mounts", "Name"])) return false;
    const item = value[0] as Record<string, unknown>;
    const config = item.Config;
    const host = item.HostConfig;
    const mounts = item.Mounts;
    if (!exact(config, ["Cmd", "Entrypoint", "Env", "ExposedPorts", "Healthcheck", "Image", "Labels", "User", "Volumes"]) || !exact(host, ["AutoRemove", "Binds", "CapAdd", "CapDrop", "CgroupnsMode", "DeviceRequests", "Devices", "Dns", "ExtraHosts", "GroupAdd", "IpcMode", "Links", "LogConfig", "Memory", "NanoCpus", "NetworkMode", "PidMode", "PidsLimit", "PortBindings", "Privileged", "PublishAllPorts", "ReadonlyRootfs", "RestartPolicy", "SecurityOpt", "UTSMode", "UsernsMode", "VolumesFrom"]) || !Array.isArray(mounts) || mounts.length !== 1 || !exact(mounts[0], ["Destination", "Name", "RW", "Type"])) return false;
    const labels = spec.createArgs.filter((value, index) => spec.createArgs[index - 1] === "--label").map((value) => value.split("=", 2));
    const runtimeLabels = Object.fromEntries(labels);
    const expectedLabels = { ...spec.imageLabels, ...runtimeLabels };
    const mounted = mounts[0] as Record<string, unknown>;
    const command = spec.createArgs[spec.createArgs.indexOf(spec.imageReference) + 1];
    const cmd = config.Cmd as unknown;
    return item.Name === `/${spec.containerName}` && config.Image === spec.imageReference
      && JSON.stringify(config.Entrypoint) === JSON.stringify(EVIDENCE_EXPORT_HELPER_ENTRYPOINT)
      && (cmd === null || (Array.isArray(cmd) && cmd.length === 0))
      && exactHelperEnv(config.Env)
      && config.ExposedPorts === null && config.Healthcheck === null && config.Volumes === null
      && config.User === EVIDENCE_EXPORT_HELPER_USER
      && exact(config.Labels as Record<string, unknown>, Object.keys(expectedLabels))
      && Object.entries(expectedLabels).every(([key, value]) => config.Labels as Record<string, unknown> !== null && (config.Labels as Record<string, unknown>)[key] === value)
      && command === undefined
      && host.AutoRemove === false && host.NetworkMode === "none" && host.ReadonlyRootfs === true
      && host.Privileged === false && JSON.stringify(host.CapAdd) === JSON.stringify(null)
      && JSON.stringify(host.CapDrop) === JSON.stringify(["ALL"]) && JSON.stringify(host.SecurityOpt) === JSON.stringify(["no-new-privileges=true"])
      && host.PidsLimit === 64 && host.Memory === 134217728 && host.NanoCpus === 250_000_000
      && host.IpcMode === "none" && host.PidMode === "" && host.UTSMode === ""
      && host.UsernsMode === "" && host.CgroupnsMode === "private"
      && [host.Binds, host.VolumesFrom, host.ExtraHosts, host.Dns, host.Links, host.GroupAdd, host.DeviceRequests].every((value) => value === null)
      && (host.Devices === null || Array.isArray(host.Devices) && host.Devices.length === 0)
      && (host.PortBindings === null || exact(host.PortBindings, []))
      && host.PublishAllPorts === false && exact(host.RestartPolicy, ["MaximumRetryCount", "Name"]) && (host.RestartPolicy as Record<string, unknown>).Name === "no"
      && (host.RestartPolicy as Record<string, unknown>).MaximumRetryCount === 0
      && exact(host.LogConfig, ["Config", "Type"]) && (host.LogConfig as Record<string, unknown>).Type === "none"
      && JSON.stringify((host.LogConfig as Record<string, unknown>).Config) === JSON.stringify({})
      && mounted.Type === "volume" && mounted.Destination === EVIDENCE_EXPORT_MOUNT && mounted.RW === false
      && typeof mounted.Name === "string" && mounted.Name.length > 0
      && spec.createArgs.some((arg) => arg.startsWith(`type=volume,src=${mounted.Name},`));
  } catch { return false; }
};
export const executeEvidenceExport = async (input: { readonly args: readonly string[]; readonly executor: DockerEvidenceExportExecutor; readonly signal?: AbortSignal; readonly timeoutMs: number }): Promise<Uint8Array> => {
  const argv = boundedRedactedText(input.args.join(" "));
  let output: { readonly bytes: Uint8Array } | undefined;
  try {
    output = await input.executor("docker", input.args, { signal: input.signal, timeout: input.timeoutMs });
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return fail(`thrown failure: ${name}: ${boundedRedactedText(message)}; docker argv: ${argv}`);
  }
  if (!output) return fail(`shape failure: missing output; docker argv: ${argv}`);
  if (!(output.bytes instanceof Uint8Array)) return fail(`shape failure: output.bytes is not a Uint8Array; docker argv: ${argv}`);
  if (output.bytes.byteLength > MAX_OUTPUT_BYTES) return fail(`shape failure: output.bytes exceeds MAX_OUTPUT_BYTES (${output.bytes.byteLength} bytes); docker argv: ${argv}`);
  return new Uint8Array(output.bytes);
};
