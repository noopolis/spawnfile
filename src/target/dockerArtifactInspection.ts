import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { assertOrdinaryJsonGraph, parseOpaqueTargetHandle, type OpaqueTargetHandle } from "./contracts.js";
import { isImmutableDockerImageReference, type DockerArtifactExecutor, type DockerArtifactSpec, type DockerConfigArtifactSpec } from "./dockerArtifactsProvider.js";

const ERROR = "Docker artifact resolution failed";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const fail = (): never => { throw new Error(ERROR); };
const digest = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-artifact.${domain}.v1\0`, "utf8").update(value, "utf8").digest("hex");
const label = (prefix: string, value: string): string => `${prefix}${digest("label", value).slice(0, 63)}`;
const validDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);
const reference = (value: unknown): value is string => isImmutableDockerImageReference(value);

export const createDockerArtifactSpec = (input: { artifactManifestDigest: string; imageDigest: string; imageReference: string; operationHandle: OpaqueTargetHandle; requestDigest: string; selectedTargetHandle: OpaqueTargetHandle }): DockerArtifactSpec => {
  if (!validDigest(input.artifactManifestDigest) || !validDigest(input.imageDigest) || !validDigest(input.requestDigest)
    || !reference(input.imageReference) || !input.imageReference.endsWith(`@${input.imageDigest}`)) return fail();
  parseOpaqueTargetHandle(input.operationHandle); parseOpaqueTargetHandle(input.selectedTargetHandle);
  const authority = `${input.operationHandle}\0${input.requestDigest}\0${input.artifactManifestDigest}\0${input.imageDigest}`;
  return Object.freeze({ imageDigest: input.imageDigest, imageReference: input.imageReference,
    inspectionFormat: "[{\"RepoDigests\":{{json .RepoDigests}}}]" as const,
    labels: Object.freeze({ spawnfile_artifact_v1_image: label("i", input.imageDigest), spawnfile_artifact_v1_kind: "world_artifact",
      spawnfile_artifact_v1_manifest: label("m", input.artifactManifestDigest), spawnfile_artifact_v1_operation: label("o", `${input.operationHandle}\0${input.requestDigest}`),
      spawnfile_artifact_v1_target: label("t", input.selectedTargetHandle), spawnfile_artifact_v1_version: "v1" }),
    resultHandle: parseOpaqueTargetHandle(`opaque_${digest("result", authority)}`) });
};
export const createDockerConfigArtifactSpec = (input: { archiveDigest: string; artifactManifestDigest: string; baseImageConfigDigest: string; buildPolicyDigest: string; bundleDigest: string; configId: string; daemonEpoch: string; entrypoint: string; launcherDigest: string; networkAlias: string; operationHandle: OpaqueTargetHandle; requestDigest: string; selectedTargetHandle: OpaqueTargetHandle; platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" }; platformDigest: string }): DockerConfigArtifactSpec => {
  if (![input.archiveDigest, input.artifactManifestDigest, input.baseImageConfigDigest, input.buildPolicyDigest, input.bundleDigest, input.configId, input.daemonEpoch, input.launcherDigest, input.platformDigest, input.requestDigest].every(validDigest)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(input.entrypoint) || input.entrypoint.includes("//") || input.entrypoint.split("/").some((part) => part === "." || part === "..")
    || !/^[a-z][a-z0-9-]{0,62}$/u.test(input.networkAlias) || (input.platform.architecture !== "amd64" && input.platform.architecture !== "arm64") || input.platform.os !== "linux") return fail();
  parseOpaqueTargetHandle(input.operationHandle); parseOpaqueTargetHandle(input.selectedTargetHandle);
  const authority = [input.operationHandle, input.requestDigest, input.archiveDigest, input.artifactManifestDigest, input.baseImageConfigDigest, input.bundleDigest, input.buildPolicyDigest, input.configId, input.daemonEpoch, input.entrypoint, input.launcherDigest, input.networkAlias, input.platform.os, input.platform.architecture, input.platformDigest].join("\0");
  return Object.freeze({ configId: input.configId, imageDigest: input.configId, imageReference: input.configId,
    labels: Object.freeze({ spawnfile_artifact_v1_config: label("c", input.configId), spawnfile_artifact_v1_kind: "world_artifact",
      spawnfile_artifact_v1_manifest: label("m", input.artifactManifestDigest), spawnfile_artifact_v1_operation: label("o", `${input.operationHandle}\0${input.requestDigest}`),
      spawnfile_artifact_v1_target: label("t", input.selectedTargetHandle), spawnfile_artifact_v1_version: "v1" }),
    resultHandle: parseOpaqueTargetHandle(`opaque_${digest("config-result", authority)}`) });
};
const bounded = (value: unknown): value is string => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 32_768 && Buffer.from(value, "utf8").toString("utf8") === value;
export const executeDockerArtifact = async (input: { args: string[]; executor: DockerArtifactExecutor; signal?: AbortSignal; timeoutMs: number }): Promise<{ stderr: string; stdout: string }> => {
  try { const result = await input.executor("docker", input.args, { signal: input.signal, timeout: input.timeoutMs }); if (!result || !bounded(result.stdout) || !bounded(result.stderr)) return fail(); return result; } catch { return fail(); }
};
const skip = (source: string, index: number): number => { while (/[\t\n\r ]/u.test(source[index] ?? "")) index += 1; return index; };
const stringEnd = (source: string, index: number): number => { for (let cursor = index + 1; cursor < source.length; cursor += 1) { if (source[cursor] === "\\") { cursor += 1; continue; } if (source[cursor] === "\"") return cursor + 1; } return fail(); };
const uniqueJson = (source: string, start: number): number => {
  let index = skip(source, start); const token = source[index]; if (token === "\"") return stringEnd(source, index);
  if (token === "{") { index = skip(source, index + 1); const keys = new Set<string>(); if (source[index] === "}") return index + 1;
    while (true) { if (source[index] !== "\"") return fail(); const end = stringEnd(source, index); const key = JSON.parse(source.slice(index, end)) as string;
      if (keys.has(key)) return fail(); keys.add(key); index = skip(source, end); if (source[index] !== ":") return fail(); index = skip(source, uniqueJson(source, index + 1)); if (source[index] === "}") return index + 1; if (source[index] !== ",") return fail(); index = skip(source, index + 1); }
  }
  if (token === "[") { index = skip(source, index + 1); if (source[index] === "]") return index + 1; while (true) { index = skip(source, uniqueJson(source, index)); if (source[index] === "]") return index + 1; if (source[index] !== ",") return fail(); index = skip(source, index + 1); } }
  const end = source.slice(index).search(/[\t\n\r ,}\]]/u); if (end === 0) return fail(); return end < 0 ? source.length : index + end;
};
const parse = (stdout: string): unknown => { if (!bounded(stdout) || skip(stdout, uniqueJson(stdout, 0)) !== stdout.length) return fail(); const value = JSON.parse(stdout) as unknown; assertOrdinaryJsonGraph(value); return value; };
export const isExpectedDockerArtifact = (stdout: string, spec: DockerArtifactSpec): boolean => {
  try { const value = parse(stdout); if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object" || Array.isArray(value[0])) return false;
    const item = value[0] as Record<string, unknown>; const repo = item.RepoDigests;
    return Object.keys(item).length === 1 && Array.isArray(repo) && repo.length > 0 && repo.length <= 32 && repo.every(reference)
      && new Set(repo).size === repo.length && repo.includes(spec.imageReference); } catch { return false; }
};
