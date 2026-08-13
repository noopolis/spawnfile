import { SpawnfileError } from "../shared/index.js";
import type { DockerTargetExecutors } from "./dockerCommandExecutor.js";
import {
  createTargetPublicArtifactSnapshot,
  parseTargetPublicArtifactSnapshotRequest,
  type TargetPublicArtifactSnapshot,
  type TargetPublicArtifactSnapshotRequest
} from "./publicArtifactSnapshot.js";
import {
  type DockerWorldServiceExecutor
} from "./dockerWorldServiceProvider.js";
import {
  inspectDockerWorldService,
  sameWorldServiceValue,
  worldServiceSpecForBinding
} from "./dockerWorldServiceLifecycle.js";
import type { WorldServiceAuthorityStore } from "./dockerWorldServiceStore.js";

export const TARGET_PUBLIC_ARTIFACT_SNAPSHOT_ERROR =
  "Target public artifact snapshot failed";

export interface DockerPublicArtifactSnapshotOptions {
  readonly authorityStore: WorldServiceAuthorityStore;
  readonly context: string;
  readonly contentExecutor: DockerTargetExecutors["publicArtifact"];
  readonly executor: DockerWorldServiceExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface PublicArtifactSnapshotReader {
  snapshot(raw: unknown): Promise<TargetPublicArtifactSnapshot>;
}

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const fail = (): never => {
  throw new SpawnfileError("runtime_error", TARGET_PUBLIC_ARTIFACT_SNAPSHOT_ERROR);
};
const validOptions = (
  raw: DockerPublicArtifactSnapshotOptions
): DockerPublicArtifactSnapshotOptions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || typeof raw.context !== "string" || !CONTEXT_PATTERN.test(raw.context)
    || typeof raw.contentExecutor !== "function"
    || typeof raw.executor !== "function"
    || !raw.authorityStore || typeof raw.authorityStore.loadService !== "function"
    || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1
    || raw.timeoutMs > 120_000
    || raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) return fail();
  return raw;
};

const exactBinding = async (
  request: TargetPublicArtifactSnapshotRequest,
  options: DockerPublicArtifactSnapshotOptions
) => {
  const binding = await options.authorityStore.loadService(request.world_service_handle);
  const authorization = binding.resolution.authorization;
  if (binding.world_service_handle !== request.world_service_handle
    || authorization.run_id !== request.run_id
    || authorization.descriptor_digest !== request.descriptor_digest
    || !sameWorldServiceValue(authorization.selected_target, request.selected_target)) return fail();
  return binding;
};

const readPublicArtifact = async (
  containerId: string,
  request: TargetPublicArtifactSnapshotRequest,
  options: DockerPublicArtifactSnapshotOptions
): Promise<Uint8Array> => {
  try {
    const resolved = await options.contentExecutor("docker", [
      "--context", options.context,
      "container", "exec",
      containerId,
      "/usr/bin/readlink",
      "-e",
      request.artifact.path
    ], {
      signal: options.signal,
      timeout: options.timeoutMs
    });
    if (!resolved || !(resolved.bytes instanceof Uint8Array)) return fail();
    const resolvedPath = new TextDecoder("utf-8", { fatal: true })
      .decode(resolved.bytes);
    // Reject the final file and every parent alias. The world may publish only
    // the exact regular path that its descriptor declared, never a symlink
    // into private evidence, credentials, or another runtime surface.
    if (resolvedPath !== `${request.artifact.path}\n`) return fail();
    const result = await options.contentExecutor("docker", [
      "--context", options.context,
      "container", "exec",
      containerId,
      "/bin/cat",
      request.artifact.path
    ], {
      signal: options.signal,
      timeout: options.timeoutMs
    });
    if (!result || !(result.bytes instanceof Uint8Array)
      || result.bytes.byteLength > request.artifact.max_bytes) return fail();
    return Uint8Array.from(result.bytes);
  } catch {
    return fail();
  }
};

class DockerPublicArtifactSnapshotReader implements PublicArtifactSnapshotReader {
  readonly #options: DockerPublicArtifactSnapshotOptions;

  public constructor(options: DockerPublicArtifactSnapshotOptions) {
    this.#options = validOptions(options);
  }

  public async snapshot(raw: unknown): Promise<TargetPublicArtifactSnapshot> {
    let request: TargetPublicArtifactSnapshotRequest;
    try { request = parseTargetPublicArtifactSnapshotRequest(raw); }
    catch { return fail(); }
    const binding = await exactBinding(request, this.#options).catch(fail);
    const spec = worldServiceSpecForBinding(binding);
    const before = await inspectDockerWorldService(
      binding.container_id,
      spec,
      this.#options
    ).catch(fail);
    if (!before || before.containerId !== binding.container_id
      || before.status !== "running") return fail();

    const content = await readPublicArtifact(
      binding.container_id,
      request,
      this.#options
    );
    const after = await inspectDockerWorldService(
      binding.container_id,
      spec,
      this.#options
    ).catch(fail);
    if (!after || after.containerId !== before.containerId
      || after.status !== "running") return fail();
    return createTargetPublicArtifactSnapshot({ content, request });
  }
}

export const createDockerPublicArtifactSnapshotReader = (
  options: DockerPublicArtifactSnapshotOptions
): PublicArtifactSnapshotReader => new DockerPublicArtifactSnapshotReader(options);
